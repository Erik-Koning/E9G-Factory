// The operator's keys for the ways the factory reaches them (e9g connect), in the macOS Keychain, where the watchdog,
// a launchd job, reads them without a prompt. The guard refuses agents the commands that read or change them, but
// it's a seatbelt: any code running as the operator can reach an item the security tool made, so each key should
// carry no more access than the factory uses.
import { spawnSync } from "node:child_process";

export function readSecret(service: string, account: string): string | null {
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

// Whether the item is there, without reading the secret.
export const hasSecret = (service: string, account: string): boolean =>
  spawnSync("security", ["find-generic-password", "-s", service, "-a", account], { stdio: "ignore" }).status === 0;

// Through security's interactive mode, so the secret never appears in a process's arguments.
export function storeSecret(service: string, account: string, label: string, secret: string): boolean {
  if (!/^[\w.-]+$/.test(secret)) return false;
  spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${service} -a ${account} -l "${label}" -w ${secret}\n`,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return readSecret(service, account) === secret;
}

export const forgetSecret = (service: string, account: string): void => {
  spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
};
