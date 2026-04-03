import { validateCommitMessage } from "../../src/git/commit-msg.js";

describe("validateCommitMessage", () => {
  describe("valid conventional commits", () => {
    const validMessages = [
      "feat: add login",
      "fix(api): handle 500",
      "refactor!: rewrite auth",
      "chore: bump deps",
      "ci(gh): add workflow",
      "build: upgrade webpack",
      "test: add unit tests",
      "docs(readme): fix typo",
      "style: fix whitespace",
      "perf: reduce bundle",
      "revert: undo change",
    ];

    test.each(validMessages)("accepts: %s", (msg) => {
      expect(validateCommitMessage(msg)).toEqual({ valid: true });
    });
  });

  describe("valid bypass messages", () => {
    const bypassMessages = [
      "Merge branch 'main'",
      "Merge pull request #42 from origin/feature",
      'Revert "feat: something"',
      "fixup! feat: something",
      "squash! fix: something",
      "amend! chore: something",
    ];

    test.each(bypassMessages)("allows through: %s", (msg) => {
      expect(validateCommitMessage(msg)).toEqual({ valid: true });
    });
  });

  describe("invalid messages", () => {
    test("rejects empty string", () => {
      const result = validateCommitMessage("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Commit message is empty.");
    });

    test("rejects whitespace-only", () => {
      const result = validateCommitMessage("   \n  ");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Commit message is empty.");
    });

    test("rejects unknown type", () => {
      const result = validateCommitMessage("wip: work in progress");
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown commit type "wip"');
    });

    test("rejects no type prefix", () => {
      const result = validateCommitMessage("add login page");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not match conventional format");
    });

    test("rejects uppercase type", () => {
      const result = validateCommitMessage("FEAT: uppercase");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not match conventional format");
    });

    test("rejects missing space after colon", () => {
      const result = validateCommitMessage("feat:no space");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not match conventional format");
    });
  });

  describe("edge cases", () => {
    test("validates only the first line of a multi-line message", () => {
      const msg = "feat: first line\n\nBody paragraph with details.";
      expect(validateCommitMessage(msg)).toEqual({ valid: true });
    });

    test("rejects multi-line where first line is invalid", () => {
      const msg = "bad first line\n\nfeat: this is in the body";
      expect(validateCommitMessage(msg).valid).toBe(false);
    });

    test("accepts breaking change with scope and bang", () => {
      expect(validateCommitMessage("feat(api)!: remove endpoint")).toEqual({
        valid: true,
      });
    });
  });
});
