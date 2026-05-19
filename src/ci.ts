export type CiProfile = "default" | "windows-fast";

export interface CiCommand {
  label: string;
  args: string[];
}

export function resolveCiProfile(value: string | undefined): CiProfile {
  if (value === undefined || value === "" || value === "default") return "default";
  if (value === "windows-fast") return "windows-fast";
  throw new Error(`Unsupported SUPIPOWERS_CI_PROFILE: ${value}`);
}

export function getCiPlan(profile: CiProfile): CiCommand[] {
  const typecheck = { label: "Typecheck", args: ["bun", "run", "typecheck"] };
  if (profile === "windows-fast") {
    return [
      typecheck,
      { label: "Windows portability tests", args: ["bun", "run", "test:windows"] },
    ];
  }

  return [
    typecheck,
    { label: "Test", args: ["bun", "run", "test"] },
  ];
}

export function runCi(profileValue: string | undefined = process.env.SUPIPOWERS_CI_PROFILE): number {
  const profile = resolveCiProfile(profileValue);
  for (const command of getCiPlan(profile)) {
    console.log(`\n> ${command.label}`);
    const result = Bun.spawnSync({
      cmd: command.args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    if (!result.success) return result.exitCode;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = runCi();
}
