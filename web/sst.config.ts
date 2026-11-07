/// <reference path="./.sst/platform/config.d.ts" />
// The web app on AWS: the container on Lightsail, CloudFront in front.
//
//   viewer ──https──▶ CloudFront ──https, x-a6g-origin: <secret>──▶ Lightsail container service ──▶ Next.js (web/)
//                      │ a viewer-request function sets x-a6g-viewer-ip (the viewer's address) and x-forwarded-host
//                      │ /_next/static/* cached; everything else passed through, cookies and all
//
// The app refuses any request without the CDN's secret (proxy.ts), so nobody reaches it around CloudFront or sets
// the viewer-IP header themselves; Lightsail's health check, which comes from inside, reaches /api/health alone.
//
// Email goes through Amazon SES, from A6G_WEB_SENDER, an address at a domain made an SES sender once for every stage
// and app (scripts/ses-domain.sh: DKIM, its MAIL FROM, DMARC; not per stage, so removing one keeps the domain's mail).
// Until the account has SES production access, SES sends only to verified addresses. Lightsail can't take an IAM role,
// so each stage sends with its own IAM user's key, which may only send from that address.
//
// Before the first deploy, per stage (the values stay in SST's encrypted secrets, never in the repository):
//   npx sst secret set MongodbUri "mongodb+srv://…" --stage production
//   npx sst secret set BetterAuthSecret "$(openssl rand -base64 32)" --stage production
// Then: A6G_WEB_SENDER=no-reply@a6gfactory.dev A6G_WEB_DOMAIN=app.a6gfactory.dev npx sst deploy --stage production
//
// Settings, from the environment of the deploy:
//   A6G_WEB_SENDER   the address email comes from (required), at a domain verified in SES: no-reply@a6gfactory.dev.
//   A6G_WEB_DOMAIN   the app's own domain, in a Route 53 hosted zone of this account (a certificate is made for it).
//                    Without it the app is served on CloudFront's own *.cloudfront.net address. Passkeys belong to
//                    the domain they were made on, so choose it before people add theirs.
//   A6G_WEB_REGION   where Lightsail runs it (us-east-2: the account's organization allows Lightsail, SSM and ECR there,
//                    and it's near the database's region).
//   A6G_WEB_POWER    the container's size: nano, micro (1 GB, the default), small, medium, large, xlarge.
//   A6G_WEB_SCALE    how many containers (1).
export default $config({
  app(input) {
    return {
      name: "a6g-web",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      providers: {
        aws: { region: (process.env.A6G_WEB_REGION ?? "us-east-2") as "us-east-2" },
        command: "1.0.1",
        "docker-build": "0.0.22",
        random: "4.21.4",
      },
    };
  },
  async run() {
    const path = await import("node:path");
    const domain = process.env.A6G_WEB_DOMAIN || undefined;
    const sender = process.env.A6G_WEB_SENDER ?? "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) throw new Error("A6G_WEB_SENDER: the address the app's email comes from, such as a6g@example.com");
    const power = process.env.A6G_WEB_POWER ?? "micro";
    const scale = Number(process.env.A6G_WEB_SCALE ?? "1");
    if (!Number.isInteger(scale) || scale < 1 || scale > 20) throw new Error("A6G_WEB_SCALE: a whole number of containers, 1 to 20");

    const mongodbUri = new sst.Secret("MongodbUri");
    const authSecret = new sst.Secret("BetterAuthSecret");
    // Only CloudFront and the app know it; kept in SST's state, made once per stage.
    const originSecret = new random.RandomPassword("OriginSecret", { length: 48, special: false });

    // Email: a key that may send from the sender's address and nothing else (the domain is SES's already).
    const mailer = new aws.iam.User("WebMailer", { path: "/a6g/" });
    new aws.iam.UserPolicy("WebMailerSends", {
      user: mailer.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["ses:SendEmail", "ses:SendRawEmail"],
            Resource: "*",
            Condition: { StringEquals: { "ses:FromAddress": sender } },
          },
        ],
      }),
    });
    const mailerKey = new aws.iam.AccessKey("WebMailerKey", { user: mailer.name });

    const service = new aws.lightsail.ContainerService("Web", { name: `a6g-web-${$app.stage}`.slice(0, 63), power, scale });

    // The image: built from the repository's root (the app compiles ../lib/tasks), for Lightsail's x86 hosts, into the
    // local Docker engine, then pushed into the container service's own registry. Not ECR: the organization's resource
    // control policy refuses Lightsail's puller role, which belongs to AWS's account, not the organization.
    const repository = path.resolve($cli.paths.root, "..");
    const local = `a6g-web-${$app.stage}:latest`;
    const image = new dockerbuild.Image("WebImage", {
      context: { location: repository },
      dockerfile: { location: path.join(repository, "web", "Dockerfile") },
      platforms: ["linux/amd64"],
      // A named buildx builder (scripts/rosetta-builder.sh on Apple silicon); else the provider makes its own.
      builder: process.env.BUILDX_BUILDER ? { name: process.env.BUILDX_BUILDER } : undefined,
      buildArgs: { SERVER_ACTIONS_ORIGINS: domain ?? "" },
      tags: [local],
      load: true,
      push: false,
    });
    // Each new build is pushed once (AWS's lightsailctl plugin does the pushing) and deployed by the name Lightsail
    // gives it (":a6g-web-dev.web.3"). A replaced image is deleted once the update is through; the one a deployment
    // still runs can't be, and a removed stage's service takes its images with it, so a failed delete is let go.
    const region = aws.getRegionOutput().name;
    const pushed = new command.local.Command("WebImagePush", {
      interpreter: ["/bin/bash", "-c"],
      create: $interpolate`set -eo pipefail; aws lightsail push-container-image --region ${region} --service-name ${service.name} --label web --image ${local} | sed -nE 's/.*Refer to this image as "([^"]+)".*/\\1/p'`,
      delete: $interpolate`aws lightsail delete-container-image --region ${region} --service-name ${service.name} --image "$PULUMI_COMMAND_STDOUT" || true`,
      triggers: [image.contextHash, image.digest],
    });

    // CloudFront: the viewer's address and the public host for the app, the secret on every request to the origin.
    const viewerRequest = new aws.cloudfront.Function("WebViewerRequest", {
      runtime: "cloudfront-js-2.0",
      publish: true,
      comment: "Anything Factory web: the viewer's IP address and public host, for the app",
      code: [
        "function handler(event) {",
        "  var request = event.request;",
        "  // Replaces whatever a viewer sent under these names.",
        '  request.headers["x-a6g-viewer-ip"] = { value: event.viewer.ip };',
        '  request.headers["x-forwarded-host"] = { value: request.headers.host.value };',
        "  return request;",
        "}",
      ].join("\n"),
    });
    // AWS's managed policies: no caching, every viewer header but Host (the origin's own name goes to Lightsail), and
    // the usual caching for Next's hashed static files.
    const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
    const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
    const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
    const ORIGIN = "lightsail";
    const cdn = new sst.aws.Cdn("WebCdn", {
      comment: `Anything Factory web (${$app.stage})`,
      ...(domain ? { domain } : {}),
      origins: [
        {
          originId: ORIGIN,
          domainName: service.url.apply((url) => new URL(url).hostname),
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "https-only",
            originSslProtocols: ["TLSv1.2"],
            originReadTimeout: 30,
            originKeepaliveTimeout: 5,
          },
          customHeaders: [{ name: "x-a6g-origin", value: originSecret.result }],
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: ORIGIN,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
        compress: true,
        cachePolicyId: CACHING_DISABLED,
        originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
        functionAssociations: [{ eventType: "viewer-request", functionArn: viewerRequest.arn }],
      },
      orderedCacheBehaviors: [
        {
          pathPattern: "/_next/static/*",
          targetOriginId: ORIGIN,
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD"],
          cachedMethods: ["GET", "HEAD"],
          compress: true,
          cachePolicyId: CACHING_OPTIMIZED,
        },
      ],
    });
    const url = domain ? `https://${domain}` : cdn.url;

    // The running app: the image pushed above (a new build deploys a new version), the settings it reads at start.
    // Lightsail keeps a deployment's environment in the deployment (the database's connection string, the auth secret,
    // the mailer's key), readable by anyone with Lightsail access to this account: give that access to the operators only.
    new aws.lightsail.ContainerServiceDeploymentVersion("WebDeployment", {
      serviceName: service.name,
      containers: [
        {
          containerName: "web",
          image: pushed.stdout.apply((name) => {
            if (!name.startsWith(":")) throw new Error(`lightsail push-container-image gave no image name (${name || "empty output"})`);
            return name.trim();
          }),
          ports: { "3000": "HTTP" },
          environment: {
            NODE_ENV: "production",
            MONGODB_URI: mongodbUri.value,
            A6G_DATABASE: "a6g",
            AUTH_DATABASE: "a6g_web",
            BETTER_AUTH_SECRET: authSecret.value,
            BETTER_AUTH_URL: url,
            SES_REGION: region,
            SES_ACCESS_KEY_ID: mailerKey.id,
            SES_SECRET_ACCESS_KEY: mailerKey.secret,
            MAIL_FROM: `${$app.stage === "production" ? "Anything Factory" : `Anything Factory (${$app.stage})`} <${sender}>`,
            CLIENT_IP_HEADER: "x-a6g-viewer-ip",
            ORIGIN_SECRET: originSecret.result,
          },
        },
      ],
      publicEndpoint: {
        containerName: "web",
        containerPort: 3000,
        healthCheck: { path: "/api/health", intervalSeconds: 10, timeoutSeconds: 5, healthyThreshold: 2, unhealthyThreshold: 3, successCodes: "200" },
      },
    });

    return { url, origin: service.url, sender };
  },
});
