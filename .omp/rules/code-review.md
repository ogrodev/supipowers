---
condition:
  - '\b([rR][eE][vV][iI][eE][wW]|[lL][oO][oO][kK][sS] [gG][oO][oO][dD]|[aA][pP][pP][rR][oO][vV][eE]|LGTM|lgtm|[nN][iI][tT]|[bB][lL][oO][cC][kK][eE][rR])\b'
triggers:
  - review
  - looks good
  - approve
  - LGTM
  - nit
  - blocker
scope:
  - text
---
# Code Review

When reviewing code:
- Ground every finding in a specific path and behavior.
- Separate blockers from maintainability suggestions.
- Check correctness, tests, types, error handling, cross-platform paths/subprocesses, and layer boundaries.
- Do not rubber-stamp broad changes without reading affected call sites.
- Avoid speculative findings; mark uncertainty explicitly.
