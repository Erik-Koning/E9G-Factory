#!/usr/bin/env bash
# Once per domain (not per stage, so removing a stage never takes a domain's email with it): makes a domain whose DNS
# is a Route 53 zone in this account an Amazon SES sender, signed and authorised for it, so mail from it isn't spam:
#   - the SES identity, with Easy DKIM (three CNAMEs);
#   - its own MAIL FROM domain, mail.<domain> (an MX and an SPF record), so SPF lines up with the sender;
#   - a DMARC policy that asks receivers to quarantine mail that fails both.
# Safe to run again: it makes what's missing and sets the records to what they should be.
#
#   AWS_PROFILE=a6g AWS_REGION=us-east-2 web/scripts/ses-domain.sh a6gfactory.dev
#
# SES verifies the domain once its DNS answers (minutes after the registrar points to the zone's name servers). Until
# the account has SES production access, it sends only to verified addresses.
set -euo pipefail

domain=${1:?usage: ses-domain.sh <domain>}
region=${AWS_REGION:?set AWS_REGION to the region the app sends from (us-east-2)}
mail_from="mail.$domain"

zone=$(aws route53 list-hosted-zones-by-name --dns-name "$domain" --max-items 1 \
  --query "HostedZones[?Name=='$domain.'].Id | [0]" --output text)
if [ -z "$zone" ] || [ "$zone" = "None" ]; then
  echo "ses-domain: no Route 53 zone for $domain in this account" >&2
  exit 1
fi

if ! aws sesv2 get-email-identity --email-identity "$domain" --region "$region" >/dev/null 2>&1; then
  aws sesv2 create-email-identity --email-identity "$domain" --region "$region" >/dev/null
  echo "ses-domain: made $domain an SES identity in $region"
fi
aws sesv2 put-email-identity-mail-from-attributes --email-identity "$domain" --region "$region" \
  --mail-from-domain "$mail_from" --behavior-on-mx-failure USE_DEFAULT_VALUE
tokens=$(aws sesv2 get-email-identity --email-identity "$domain" --region "$region" --query 'DkimAttributes.Tokens' --output text)

batch=$(python3 - "$domain" "$region" "$mail_from" $tokens <<'PY'
import json, sys
domain, region, mail_from, *tokens = sys.argv[1:]
def record(name, kind, *values):
    return {"Action": "UPSERT", "ResourceRecordSet": {"Name": name, "Type": kind, "TTL": 1800, "ResourceRecords": [{"Value": v} for v in values]}}
changes = [record(f"{t}._domainkey.{domain}", "CNAME", f"{t}.dkim.amazonses.com") for t in tokens]
changes.append(record(mail_from, "MX", f"10 feedback-smtp.{region}.amazonses.com"))
changes.append(record(mail_from, "TXT", '"v=spf1 include:amazonses.com ~all"'))
changes.append(record(f"_dmarc.{domain}", "TXT", '"v=DMARC1; p=quarantine; adkim=r; aspf=r"'))
print(json.dumps({"Comment": f"SES sending for {domain}", "Changes": changes}))
PY
)
aws route53 change-resource-record-sets --hosted-zone-id "$zone" --change-batch "$batch" --query 'ChangeInfo.Status' --output text >/dev/null
echo "ses-domain: DKIM, MAIL FROM ($mail_from) and DMARC records set in $zone"
aws sesv2 get-email-identity --email-identity "$domain" --region "$region" \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}' --output table
