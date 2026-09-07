import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: "tui",
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!options.hasUI) {
					return undefined;
				}
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			confirm: async (title, message) => {
				if (!options.hasUI) {
					return false;
				}
				return (
					(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
						{ label: "Yes", value: true },
						{ label: "No", value: false },
					])) ?? false
				);
			},
			input: async (title, placeholder) => {
				if (!options.hasUI) {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			notify: () => {},
		},
	};
}
