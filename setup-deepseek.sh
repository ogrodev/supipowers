#!/bin/sh
set -eu

CONFIG_DIR="${OMP_CONFIG_DIR:-$HOME/.omp/agent}"
MODELS_PATH="$CONFIG_DIR/models.yml"
SHELL_NAME="$(basename "${SHELL:-}")"

case "$SHELL_NAME" in
    zsh)
        RC_FILE="$HOME/.zshrc"
        ;;
    bash)
        if [ "$(uname -s)" = "Darwin" ]; then
            RC_FILE="$HOME/.bash_profile"
        else
            RC_FILE="$HOME/.bashrc"
        fi
        ;;
    fish)
        echo "Fish shell is not supported by this setup script. Set DEEPSEEK_API_KEY manually and add DeepSeek to $MODELS_PATH."
        exit 1
        ;;
    *)
        RC_FILE="$HOME/.profile"
        ;;
esac

if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required to update $MODELS_PATH safely. Install Bun from https://bun.sh/docs/installation and rerun this script."
    exit 1
fi

printf "DeepSeek API key: "
if [ -t 0 ]; then
    stty -echo
    IFS= read -r DEEPSEEK_API_KEY_INPUT
    stty echo
    printf "\n"
else
    IFS= read -r DEEPSEEK_API_KEY_INPUT
fi

if [ -z "$DEEPSEEK_API_KEY_INPUT" ]; then
    echo "DeepSeek API key is required."
    exit 1
fi

export DEEPSEEK_API_KEY_INPUT
export RC_FILE
export MODELS_PATH

BUN_SCRIPT_FILE="$(mktemp)"
trap 'rm -f "$BUN_SCRIPT_FILE"' EXIT
cat > "$BUN_SCRIPT_FILE" <<'BUN_SCRIPT'
import * as fs from "node:fs/promises";
import * as path from "node:path";

const apiKey = process.env.DEEPSEEK_API_KEY_INPUT;
const rcFile = process.env.RC_FILE;
const modelsPath = process.env.MODELS_PATH;

if (!apiKey || !rcFile || !modelsPath) {
    throw new Error("Missing setup environment");
}

const quotedApiKey = `'${apiKey.replaceAll("'", "'\\''")}'`;
const exportLine = `export DEEPSEEK_API_KEY=${quotedApiKey}`;

let rcContent = "";
try {
    rcContent = await Bun.file(rcFile).text();
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (/^export DEEPSEEK_API_KEY=/m.test(rcContent)) {
    rcContent = rcContent.replace(/^export DEEPSEEK_API_KEY=.*$/m, exportLine);
} else {
    rcContent = `${rcContent}${rcContent.endsWith("\n") || rcContent.length === 0 ? "" : "\n"}${exportLine}\n`;
}
await Bun.write(rcFile, rcContent);

const deepSeekProvider = {
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    auth: "none",
    models: [
        {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            reasoning: true,
            thinking: {
                minLevel: "high",
                maxLevel: "xhigh",
                mode: "effort",
            },
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 384000,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                maxTokensField: "max_tokens",
                reasoningEffortMap: {
                    high: "high",
                    xhigh: "max",
                },
                supportsToolChoice: false,
                requiresReasoningContentForToolCalls: true,
                requiresAssistantContentForToolCalls: true,
                extraBody: {
                    thinking: {
                        type: "enabled",
                    },
                },
            },
        },
        {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            thinking: {
                minLevel: "high",
                maxLevel: "xhigh",
                mode: "effort",
            },
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 384000,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                maxTokensField: "max_tokens",
                reasoningEffortMap: {
                    high: "high",
                    xhigh: "max",
                },
                supportsToolChoice: false,
                requiresReasoningContentForToolCalls: true,
                requiresAssistantContentForToolCalls: true,
                extraBody: {
                    thinking: {
                        type: "enabled",
                    },
                },
            },
        },
    ],
};

await fs.mkdir(path.dirname(modelsPath), { recursive: true });
let modelsConfig: Record<string, unknown> = {};
try {
    const text = (await Bun.file(modelsPath).text()).trim();
    if (text) {
        modelsConfig = Bun.YAML.parse(text) as Record<string, unknown>;
    }
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (!modelsConfig || typeof modelsConfig !== "object" || Array.isArray(modelsConfig)) {
    throw new Error(`${modelsPath} must contain a YAML object`);
}

const providers = modelsConfig.providers;
if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    modelsConfig.providers = {};
}
(modelsConfig.providers as Record<string, unknown>).deepseek = deepSeekProvider;
await Bun.write(modelsPath, Bun.YAML.stringify(modelsConfig, null, 2));
BUN_SCRIPT
bun "$BUN_SCRIPT_FILE"

# Load the key for commands started by this script. A child process cannot update the already-running parent shell;
# open a new terminal or run `. "$RC_FILE"` there if you need the variable immediately.
# shellcheck disable=SC1090
. "$RC_FILE"

if [ "${DEEPSEEK_API_KEY:-}" != "$DEEPSEEK_API_KEY_INPUT" ]; then
    echo "DeepSeek API key was written to $RC_FILE, but sourcing it did not expose DEEPSEEK_API_KEY. Check the file manually."
    exit 1
fi

echo "DeepSeek API key configured in $RC_FILE."
echo "DeepSeek models configured in $MODELS_PATH."
echo "Open a new terminal or run: . $RC_FILE"
echo "Use: omp --model deepseek/deepseek-v4-pro"
