const processClientName = (name: string) => {
	const basic = name.trim().toLowerCase();

	if (basic === "reform internal tasks") return "reform collective";

	if (basic === "fluid (product)") return "fluid";

	if (basic === "jillion llc") return "century";

	if (basic === "inside milk") return "milk inside";

	return basic.replaceAll("new form", "newform");
};

export const clientNamesMatch = (nameA: string, nameB: string) => {
	const a = processClientName(nameA);
	const b = processClientName(nameB);

	return a.startsWith(b) || b.startsWith(a);
};

export const taskNamesMatch = (
	nameA: string | undefined,
	nameB: string | undefined,
) => {
	if (!nameA || !nameB) {
		return false;
	}

	// normalize notes to task names:
	// - use only the first line (ignore details on second line)
	// - strip any inline [...] or (...) segments (ignore details on same line)
	// - compare using only lowercase alphanumerics
	const normalize = (name: string) => {
		const firstLine = name.trim().split(/\r?\n/)[0] ?? "";
		const withoutInlineDetails = firstLine
			.replace(/\[[^\]]*\]/g, "")
			.replace(/\([^)]*\)/g, "");
		return withoutInlineDetails.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
	};

	return normalize(nameA) === normalize(nameB);
};
