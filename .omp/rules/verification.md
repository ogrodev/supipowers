---
condition:
  - '\b([dD][oO][nN][eE]|[fF][iI][xX][eE][dD]|[cC][oO][mM][pP][lL][eE][tT][eE]|[iI][mM][pP][lL][eE][mM][eE][nN][tT][eE][dD]|[vV][eE][rR][iI][fF][iI][eE][dD]|[wW][oO][rR][kK][sS]|[pP][aA][sS][sS][iI][nN][gG])\b'
triggers:
  - done
  - fixed
  - complete
  - implemented
  - verified
  - works
  - passing
scope:
  - text
---
# Verification

When making a completion or correctness claim:
- State only what was actually exercised.
- Run the narrowest relevant Bun/TypeScript gate before yielding; prefer the test that covers the changed behavior.
- Use `bun ci` for broad repository confidence when changes cross subsystems.
- Do not imply integration, performance, or UI coverage from typecheck/build alone.
- If verification could not run, name the exact command and failure/blocker.
