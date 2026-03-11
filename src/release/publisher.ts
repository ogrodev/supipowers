/** Build prompt to execute release */
export function buildPublishPrompt(
  version: string,
  pipeline: string | null
): string {
  const steps: string[] = [
    "# Publish Release",
    "",
    `Version: ${version}`,
    "",
    "Execute these steps (ask for confirmation before each):",
    "",
    "1. Update version in package.json",
    `2. git add package.json && git commit -m "release: v${version}"`,
    `3. git tag v${version}`,
  ];

  if (pipeline === "npm") {
    steps.push("4. npm publish");
  } else if (pipeline === "github") {
    steps.push(`4. gh release create v${version} --generate-notes`);
  } else {
    steps.push("4. Ask the user what publish step to run");
  }

  steps.push(
    "",
    "IMPORTANT: Ask for user confirmation before tagging and publishing.",
    "Show them the version, changelog, and what will be published."
  );

  return steps.join("\n");
}
