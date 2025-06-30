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

	// some cards are in the format '[whatever] actual task name'
	// for those we want to use just 'actual task name'

	const onlyTaskNameA = nameA.trim().replace(/^\[.*\]/, "");
	const onlyTaskNameB = nameB.trim().replace(/^\[.*\]/, "");

	return (
		onlyTaskNameA
			.toLowerCase()
			// only keep alphanumeric characters
			.replaceAll(/[^a-z0-9]/g, "") ===
		onlyTaskNameB
			.toLowerCase()
			// only keep alphanumeric characters
			.replaceAll(/[^a-z0-9]/g, "")
	);
};
