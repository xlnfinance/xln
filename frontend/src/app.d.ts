import type { DockviewComponent } from 'dockview';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __BUILD_NUMBER__: string;
	const __BUILD_TIME__: string;

	interface Window {
		__xln?: Record<string, unknown>;
		__dockview_instance?: DockviewComponent;
		__debugScene?: import('three').Scene;
		__debugCamera?: import('three').PerspectiveCamera;
		__debugRenderer?: import('$lib/view/panels/graph3d/graph3d-renderer').GraphRenderer;
	}

	interface Navigator {
		readonly webdriver?: boolean;
		readonly xr?: {
			isSessionSupported(mode: 'immersive-vr'): Promise<boolean>;
			requestSession(mode: 'immersive-vr', options?: XRSessionInit): Promise<XRSession>;
		};
	}

	interface ImportMeta {
		readonly main?: boolean;
		readonly env?: Record<string, string | undefined>;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

declare module '*?raw' {
	const source: string;
	export default source;
}

declare module 'qrcode' {
	const QRCode: {
		toDataURL(
			text: string,
			options?: Record<string, unknown>,
		): Promise<string>;
	};
	export default QRCode;
}

export {};
