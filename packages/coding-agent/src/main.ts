/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type { Args } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { getAgentDir } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import type { ModelRuntime } from "./core/model-runtime.ts";
import { resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { InteractiveMode } from "./modes/index.ts";

/** 读取管道输入；交互终端没有管道内容。 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

/** 根据命令行文件和管道内容构造首条消息。 */
async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** 创建当前目录的会话管理器。 */
export function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

/**
 * 主函数：CLI 入口点，负责解析参数、初始化运行时、并启动相应模式（交互/RPC/打印）
 *
 * @param args - 命令行参数数组
 * @param options - 可选的主函数配置项，如扩展工厂
 */
export async function main(_args: string[], options?: MainOptions) {
	// 合并内置扩展和用户提供的扩展工厂
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];

	// 获取当前工作目录和 agent 目录
	const cwd = process.cwd();
	const agentDir = getAgentDir();

	// 解析 CLI 参数
	const parsed: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	// 创建启动阶段 settingsManager 并收集诊断信息
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// 创建会话管理器，根据 --session/--fork/--resume/--continue 等参数解析目标会话
	const sessionManager = await createSessionManager(parsed, cwd, undefined);

	// 创建项目信任存储
	const trustStore = new ProjectTrustStore(agentDir);

	// 运行时工厂：每次创建新的 agent 运行时会话时调用
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		// 确定项目是否可信
		const projectTrusted = false;
		// 创建当前 cwd 的 settingsManager
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		// 创建 agent 运行时所需的服务
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: {
				resolveProjectTrust: async ({ extensionsResult }) => {
					await resolveProjectTrusted({
						cwd,
						trustStore,
						trustOverride: parsed.projectTrustOverride,
						defaultProjectTrust: "ask",
						extensionsResult,
						projectTrustContext:
							projectTrustContext ??
							createProjectTrustContext({
								cwd,
								mode: "interactive",
								settingsManager: startupSettingsManager,
								hasUI: true,
							}),
						onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
					});
					return true;
				},
			},
			resourceLoaderOptions: {
				additionalExtensionPaths: undefined,
				additionalSkillPaths: undefined,
				additionalPromptTemplatePaths: undefined,
				additionalThemePaths: undefined,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		// 收集所有诊断信息：项目信任、服务、设置、扩展加载错误
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		// 解析可用模型范围
		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];
		// 构建会话选项
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		// 处理 --api-key 参数
		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// 创建 agent 会话
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		// 如果通过 CLI 指定了 thinking 级别，则覆盖会话的默认值
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	// 创建主运行时
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, modelFallbackMessage } = runtime;
	const { settingsManager } = services;
	// 设置终端能力覆盖
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());

	// 读取管道输入的 stdin 内容
	const stdinContent = await readPipedStdin();

	// 构建初始消息（包含文件内容和 stdin）
	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);

	// 汇总并去重所有诊断信息
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);

	// 启动交互模式
	const interactiveMode = new InteractiveMode(runtime, {
		startupDiagnostics,
		modelFallbackMessage,
		initialMessage,
		initialImages,
		initialMessages: parsed.messages,
		verbose: parsed.verbose,
		tuiMode: parsed.tuiMode,
		initialThemeSetting: parsed.useTheme,
	});

	await interactiveMode.run();
}
