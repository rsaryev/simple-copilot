import * as vscode from "vscode";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/src/resources/chat/completions";

const CONFIGURATION_KEY = "simpleCopilot";
const API_KEY_SETTING = "apiKey";

class Configuration {
  static getApiKey(): string | undefined {
    return vscode.workspace
      .getConfiguration(CONFIGURATION_KEY)
      .get<string>(API_KEY_SETTING);
  }

  static async setApiKey(apiKey: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIGURATION_KEY)
      .update(API_KEY_SETTING, apiKey, true);
  }

  static async promptForApiKey(): Promise<string | undefined> {
    const apiKey = await vscode.window.showInputBox({
      prompt: "Enter your OpenAI API Key",
      ignoreFocusOut: true,
    });
    if (apiKey) {
      await this.setApiKey(apiKey);
    }
    return apiKey;
  }
}

async function getOrPromptForApiKey(): Promise<string | undefined> {
  let apiKey = Configuration.getApiKey();
  if (!apiKey) {
    apiKey = await Configuration.promptForApiKey();
  }
  return apiKey;
}

const buildMessages = ({
  prefix,
  suffix,
  language,
}: {
  prefix: string;
  suffix: string;
  language?: string;
}): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "Provide an addition for the proposed code block. Each addition must be syntactically correct, error-free, logically fit the context before and after {{completions}}, and properly implement line breaks if needed.",
    },
    { role: "user", content: `${prefix}{{completion}}${suffix}` },
  ];

  if (language) {
    messages.unshift({
      role: "system",
      content: `Set language to ${language}`,
    });
  }
  return messages;
};

const buildFunctionParameters = () => ({
  type: "object",
  properties: {
    completions: {
      type: "array",
      maxItems: 3,
      minItems: 1,
      items: {
        type: "string",
        description: "Return the completions for the given block of code",
      },
    },
  },
  required: ["completions"],
});

function removeCodeBlockMarkers(str: string) {
  return str.replace(/```[\s\S]*?```/gm, "").trim();
}

async function getSuggestion({
  suffix,
  prefix,
  language,
}: {
  suffix: string;
  prefix: string;
  language: string;
}): Promise<string> {
  const apiKey = await getOrPromptForApiKey();
  if (!apiKey) {
    vscode.window.showErrorMessage("API Key is required for autocomplete.");
    return "";
  }

  const openai = new OpenAI({
    apiKey,
  });
  const out = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: buildMessages({
      prefix,
      suffix,
      language,
    }),
  });

  return removeCodeBlockMarkers(out.choices[0]?.message.content!);
}

export function activate(context: vscode.ExtensionContext) {
  let statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "extension.simpleCopilot";
  statusBarItem.text = `$(chip)`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const provider = new PromptProvider(statusBarItem, context);
  let disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    provider
  );
  context.subscriptions.push(disposable);
}

class PromptProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;
  private cache: Map<string, vscode.InlineCompletionItem[] | undefined> = new Map();

  constructor(
    private readonly statusBarItem: vscode.StatusBarItem,
    private readonly context: vscode.ExtensionContext
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const cacheKey = `${document.fileName}:${position.line}:${position.character}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    return new Promise((resolve, reject) => {
      this.debounceTimer = setTimeout(async () => {

        if (token.isCancellationRequested) {
          return reject("Operation cancelled");
        }

        this.statusBarItem.text = `$(sync~spin)`;

        const maxLinesContext = 25;
        const prefix = document.getText(
          new vscode.Range(
            new vscode.Position(
              Math.max(0, position.line - maxLinesContext),
              0
            ),
            position
          )
        );
        const suffix = document.getText(
          new vscode.Range(
            position,
            new vscode.Position(
              Math.min(document.lineCount - 1, position.line + maxLinesContext),
              0
            )
          )
        );

        const suggestion = await getSuggestion({
          prefix,
          suffix,
          language: document.languageId,
        });

        this.statusBarItem.text = `$(chip)`;

        const items = [{
          insertText: suggestion,
          range: new vscode.Range(position, position),
        }];
        this.cache.set(cacheKey, items);
        resolve(items);
      }, 500);
    });
  }
}
