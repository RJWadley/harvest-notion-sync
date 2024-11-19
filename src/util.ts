export const clientNamesMatch = (nameA: string, nameB: string) => {
	if (
		nameA.trim().toLowerCase() === "reform collective" &&
		nameB.trim().toLowerCase() === "reform internal tasks"
	)
		return true;

	if (
		nameB.trim().toLowerCase() === "reform collective" &&
		nameA.trim().toLowerCase() === "reform internal tasks"
	)
		return true;

	return (
		nameA.toLowerCase().trim().startsWith(nameB.toLowerCase().trim()) ||
		nameB.toLowerCase().trim().startsWith(nameA.toLowerCase().trim())
	);
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
