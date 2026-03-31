// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __BUILD_NUMBER__: string;
	const __BUILD_TIME__: string;

	interface Window {
		__xln_instance?: typeof import('@xln/runtime/xln-api') | null;
		__xln_env?: import('@xln/runtime').Env | null;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
