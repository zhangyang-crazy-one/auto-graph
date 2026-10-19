declare module "gltf-validator" {
	interface ValidationReport {
		issues: {
			numErrors: number;
			numWarnings: number;
			numInfos: number;
			numHints: number;
			messages: { code: string; message: string; pointer?: string }[];
		};
	}
	const validator: {
		validateBytes(
			data: Uint8Array,
			options?: { maxIssues?: number },
		): Promise<ValidationReport>;
	};
	export default validator;
}
