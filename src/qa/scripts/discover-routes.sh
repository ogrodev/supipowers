#!/usr/bin/env bash
# Scan project for routes, pages, forms, and auth flows.
# Usage: discover-routes.sh <cwd> <app_type>
# Output: JSONL on stdout (one JSON object per line)
set -euo pipefail

CWD="${1:-.}"
APP_TYPE="${2:-generic}"

cd "$CWD"

# Helper: output a route as JSONL
emit() {
  local routePath="$1" file="$2" type="$3" hasForm="${4:-false}" methods="${5:-}"
  if [ -n "$methods" ]; then
    echo "{\"path\": \"$routePath\", \"file\": \"$file\", \"type\": \"$type\", \"hasForm\": $hasForm, \"methods\": $methods}"
  else
    echo "{\"path\": \"$routePath\", \"file\": \"$file\", \"type\": \"$type\", \"hasForm\": $hasForm}"
  fi
}

# Check if file likely contains a form
has_form() {
  local file="$1"
  grep -qE '(<form|onSubmit|handleSubmit|useForm|formik|react-hook-form)' "$file" 2>/dev/null && echo "true" || echo "false"
}

case "$APP_TYPE" in
  nextjs-app)
    # Scan app/ directory for page.tsx/page.jsx/page.ts/page.js files
    for dir in "app" "src/app"; do
      if [ -d "$dir" ]; then
        find "$dir" -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' 2>/dev/null | while read -r file; do
          # Convert file path to route: app/login/page.tsx -> /login
          route=$(echo "$file" | sed "s|^$dir||" | sed 's|/page\.\(tsx\|jsx\|ts\|js\)$||' | sed 's|^$|/|')
          # Skip route groups (parenthesized segments)
          if echo "$route" | grep -qE '\([^)]+\)'; then
            route=$(echo "$route" | sed 's|/([^)]*)||g')
          fi
          [ -z "$route" ] && route="/"
          formFlag=$(has_form "$file")
          emit "$route" "$file" "page" "$formFlag"
        done

        # Scan for API routes
        find "$dir" -name 'route.tsx' -o -name 'route.ts' -o -name 'route.js' 2>/dev/null | while read -r file; do
          route=$(echo "$file" | sed "s|^$dir||" | sed 's|/route\.\(tsx\|ts\|js\)$||')
          methods=$(grep -oE '(GET|POST|PUT|PATCH|DELETE)' "$file" 2>/dev/null | sort -u | awk 'BEGIN{ORS=""} NR>1{printf ","} {printf "\"%s\"", $0}' || echo "")
          [ -n "$methods" ] && methods="[$methods]" || methods='["GET"]'
          emit "$route" "$file" "api" "false" "$methods"
        done
      fi
    done
    ;;

  nextjs-pages)
    # Scan pages/ directory
    for dir in "pages" "src/pages"; do
      if [ -d "$dir" ]; then
        find "$dir" -name '*.tsx' -o -name '*.jsx' -o -name '*.ts' -o -name '*.js' 2>/dev/null | while read -r file; do
          # Skip _app, _document, _error, api files
          basename=$(basename "$file")
          case "$basename" in _app.* | _document.* | _error.*) continue;; esac

          route=$(echo "$file" | sed "s|^$dir||" | sed 's|\.\(tsx\|jsx\|ts\|js\)$||' | sed 's|/index$|/|')
          [ -z "$route" ] && route="/"

          # Check if it's an API route
          if echo "$file" | grep -q '/api/'; then
            methods=$(grep -oE '(GET|POST|PUT|PATCH|DELETE)' "$file" 2>/dev/null | sort -u | awk 'BEGIN{ORS=""} NR>1{printf ","} {printf "\"%s\"", $0}' || echo "")
            [ -n "$methods" ] && methods="[$methods]" || methods='["GET"]'
            emit "$route" "$file" "api" "false" "$methods"
          else
            formFlag=$(has_form "$file")
            emit "$route" "$file" "page" "$formFlag"
          fi
        done
      fi
    done
    ;;

  react-router)
    # Grep for Route path= patterns
    grep -rn --include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.js' \
      -E '<Route\s+.*path=' "$CWD/src" 2>/dev/null | while read -r line; do
      file=$(echo "$line" | cut -d: -f1)
      routePath=$(echo "$line" | grep -oE 'path="[^"]*"' | head -1 | sed 's/path="//;s/"//')
      [ -z "$routePath" ] && continue
      formFlag=$(has_form "$file")
      emit "$routePath" "$file" "page" "$formFlag"
    done || true

    # Also check for createBrowserRouter patterns
    grep -rn --include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.js' \
      -E 'path:\s*["\x27]' "$CWD/src" 2>/dev/null | while read -r line; do
      file=$(echo "$line" | cut -d: -f1)
      routePath=$(echo "$line" | grep -oE "path:\s*[\"'][^\"']*[\"']" | head -1 | sed "s/path:\s*[\"']//;s/[\"']//")
      [ -z "$routePath" ] && continue
      formFlag=$(has_form "$file")
      emit "$routePath" "$file" "page" "$formFlag"
    done || true
    ;;

  express)
    # Grep for app.get/post/put/delete/use patterns
    grep -rn --include='*.ts' --include='*.js' \
      -E '\.(get|post|put|patch|delete|use)\s*\(\s*["\x27/]' "$CWD/src" "$CWD/routes" "$CWD/server" 2>/dev/null | while read -r line; do
      file=$(echo "$line" | cut -d: -f1)
      method=$(echo "$line" | grep -oE '\.(get|post|put|patch|delete)' | head -1 | tr -d '.')
      routePath=$(echo "$line" | grep -oE "[\"'][/][^\"']*[\"']" | head -1 | tr -d "\"'")
      [ -z "$routePath" ] && continue
      [ -z "$method" ] && method="GET"
      methods="[\"$(echo "$method" | tr '[:lower:]' '[:upper:]')\"]"
      emit "$routePath" "$file" "api" "false" "$methods"
    done || true
    ;;

  vite|generic)
    # Generic: look for common patterns
    if [ -d "src" ]; then
      # Check for React Router in any form
      grep -rln --include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.js' \
        -E '(<Route|createBrowserRouter|useRoutes)' src/ 2>/dev/null | while read -r file; do
        grep -oE 'path[=:]\s*["\x27][^"\x27]*["\x27]' "$file" 2>/dev/null | while read -r match; do
          routePath=$(echo "$match" | sed "s/path[=:]\s*[\"']//;s/[\"']//")
          [ -z "$routePath" ] && continue
          formFlag=$(has_form "$file")
          emit "$routePath" "$file" "page" "$formFlag"
        done
      done || true
    fi
    ;;
esac

# Always scan for auth-related files regardless of framework
find "$CWD/src" -type f \( -name '*auth*' -o -name '*login*' -o -name '*signup*' -o -name '*register*' \) \
  -not -path '*/node_modules/*' -not -path '*/.next/*' -not -name '*.test.*' -not -name '*.spec.*' 2>/dev/null | while read -r file; do
  # Only emit if not already covered by framework-specific scan
  formFlag=$(has_form "$file")
  # Use filename as hint for route
  basename=$(basename "$file" | sed 's/\.\(tsx\|jsx\|ts\|js\)$//')
  emit "/$basename" "$file" "auth" "$formFlag"
done || true
