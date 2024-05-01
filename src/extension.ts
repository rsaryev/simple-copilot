import * as vscode from "vscode";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/src/resources/chat/completions";

const CONFIGURATION_KEY = "simpleCopilot";
const API_KEY_SETTING = "apiKey";

class Configuration {
  static getApiKey(): string | undefined {
    return vscode.workspace.getConfiguration(CONFIGURATION_KEY).get<string>(API_KEY_SETTING);
  }

  static async setApiKey(apiKey: string): Promise<void> {
    await vscode.workspace.getConfiguration(CONFIGURATION_KEY).update(API_KEY_SETTING, apiKey, true);
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
  context,
  error,
}: {
  context: string;
  prefix: string;
  suffix: string;
  error?: string;
}): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: context },
    { role: "user", content: `${prefix}{{completion}}${suffix}` },
  ];
  if (error) {
    messages.push({ role: "system", content: error });
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

async function autocomplete({
  context,
  suffix,
  prefix,
}: {
  context: string;
  suffix: string;
  prefix: string;
}): Promise<string[]> {
  const apiKey = await getOrPromptForApiKey();
  if (!apiKey) {
    vscode.window.showErrorMessage("API Key is required for autocomplete.");
    return [];
  }

  const openai = new OpenAI({
    apiKey,
  });
  const out = await openai.chat.completions.create({
    functions: [
      {
        name: "autocomplete",
        description: `Autocomplete code`,
        parameters: buildFunctionParameters(),
      },
    ],
    model: "gpt-3.5-turbo",
    messages: buildMessages({
      context,
      prefix,
      suffix,
    }),
    function_call: { name: "autocomplete" },
  });

  return (
    JSON.parse(out.choices[0]?.message?.function_call?.arguments || "{}")
      .completions || []
  );
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
          return reject('Operation cancelled');
        }

        this.statusBarItem.text = `$(sync~spin)`;

        const currentLine = document.lineAt(position.line);
        const prefix = currentLine.text.slice(0, position.character);
        const suffix = currentLine.text.slice(position.character);

        console.log({
          prefix,
          suffix
        });
        
        const completions = await autocomplete({
          context: document.getText(),
          prefix,
          suffix,
        });

        this.statusBarItem.text = `$(chip)`;

        const completionItems = completions.map((completion) => ({
            insertText: completion,
            range: new vscode.Range(position, position),
        }));

        this.cache.set(cacheKey, completionItems);

        resolve(completionItems);
      }, 500);
    });
  }
}