/** Temporary shipping refusal for PR #131; only a reviewed source change may re-enable execution. */
export function refuseCodemodeAdmission(): void {
	throw new Error(
		"CODEMODE_SECURITY_REVIEW_REQUIRED: Codemode is disabled pending reviewed re-enable; configuration and explicit opt-in cannot activate it.",
	);
}
