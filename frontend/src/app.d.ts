// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __BUILD_NUMBER__: string;
	const __BUILD_TIME__: string;

	interface Window {
		__xln_instance?: import('@xln/runtime/xln-api').XLNModule | null;
		__xln_env?: import('@xln/runtime/xln-api').Env | null;
	}

	interface ImportMeta {
		readonly main?: boolean;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
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
