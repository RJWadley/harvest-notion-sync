/**
 * Debug script: find duplicate Notion cards for a given task + project.
 *
 * Usage:
 *   bun debug-duplicates.ts
 *
 * Mirrors the exact query + matching logic in NotionCard.ts so the results
 * are authoritative.
 */

import { Client } from "@notionhq/client";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config — edit these if needed
// ---------------------------------------------------------------------------
const TASK_NAME = "Design - HomePage";
const PROJECT_NAME = "Thoughtly V.2";
// ---------------------------------------------------------------------------

const clientDatabase = Bun.env.CLIENT_DATABASE ?? "";
const taskDatabase = Bun.env.TASK_DATABASE ?? "";
const notionToken = Bun.env.NOTION_TOKEN_A ?? "";

if (!clientDatabase || !taskDatabase || !notionToken) {
	console.error(
		"❌  Missing env vars: CLIENT_DATABASE, TASK_DATABASE, NOTION_TOKEN_A",
	);
	process.exit(1);
}

const notion = new Client({ auth: notionToken });

// ---------------------------------------------------------------------------
// Schemas (same as NotionCard.ts)
// ---------------------------------------------------------------------------
const clientSchema = z.object({
	id: z.string(),
	properties: z.object({
		"Project Name": z.object({
			title: z.array(z.object({ plain_text: z.string() })),
		}),
	}),
});

const cardSchema = z.object({
	id: z.string(),
	properties: z.object({
		"Task name": z.object({
			title: z.array(z.object({ plain_text: z.string() })),
		}),
		Project: z.object({
			relation: z.array(z.object({ id: z.string() })),
		}),
		"Time Spent": z.object({
			rich_text: z.array(z.object({ plain_text: z.string() })),
		}),
	}),
});

// ---------------------------------------------------------------------------
// Matching helpers (same as util.ts)
// ---------------------------------------------------------------------------
const processClientName = (name: string) => {
	const basic = name.trim().toLowerCase();
	if (basic === "reform internal tasks") return "reform collective";
	if (basic === "fluid (product)") return "fluid";
	if (basic === "jillion llc") return "century";
	if (basic === "inside milk") return "milk inside";
	return basic.replaceAll("new form", "newform");
};

const clientNamesMatch = (nameA: string, nameB: string) => {
	const a = processClientName(nameA);
	const b = processClientName(nameB);
	return a.startsWith(b) || b.startsWith(a);
};

const taskNamesMatch = (nameA?: string, nameB?: string) => {
	if (!nameA || !nameB) return false;
	const normalize = (name: string) => {
		const firstLine = name.trim().split(/\r?\n/)[0] ?? "";
		const withoutInlineDetails = firstLine
			.replace(/\[[^\]]*\]/g, "")
			.replace(/\([^)]*\)/g, "");
		return withoutInlineDetails.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
	};
	return normalize(nameA) === normalize(nameB);
};

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------
async function getDataSourceId(databaseId: string): Promise<string> {
	const dbInfo = await notion.databases.retrieve({ database_id: databaseId });
	if (!("data_sources" in dbInfo) || dbInfo.data_sources.length === 0) {
		throw new Error(`Database ${databaseId} has no data sources`);
	}
	const first = dbInfo.data_sources[0];
	if (!first) throw new Error(`Database ${databaseId} has no data sources`);
	return first.id;
}

async function queryDataSource(
	dataSourceId: string,
	filter?: Parameters<typeof notion.dataSources.query>[0]["filter"],
) {
	return notion.dataSources.query({ data_source_id: dataSourceId, filter });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\n🔍  Looking for duplicates of "${TASK_NAME}" in "${PROJECT_NAME}"\n`);

const clientDataSourceId = await getDataSourceId(clientDatabase);
const taskDataSourceId = await getDataSourceId(taskDatabase);

// 1. Find matching client(s)
const clientResults = await queryDataSource(clientDataSourceId);
const matchingClients = clientResults.results
	.map((c) => clientSchema.safeParse(c))
	.filter((r) => r.success)
	.filter((r) =>
		clientNamesMatch(
			r.data.properties["Project Name"].title
				.map((t) => t.plain_text)
				.join(""),
			PROJECT_NAME,
		),
	)
	.map((r) => r.data);

if (matchingClients.length === 0) {
	console.error(`❌  No Notion client found matching "${PROJECT_NAME}"`);
	process.exit(1);
}

console.log(`✅  Found ${matchingClients.length} matching client(s):`);
for (const c of matchingClients) {
	const name = c.properties["Project Name"].title
		.map((t) => t.plain_text)
		.join("");
	console.log(`    • [${c.id}] "${name}"`);
}

// 2. Query tasks filtered by those clients
const taskResults = await queryDataSource(taskDataSourceId, {
	or: matchingClients.map((c) => ({
		property: "Project",
		relation: { contains: c.id },
	})),
});

// 3. Filter by task name
const matchingCards = taskResults.results
	.map((card) => cardSchema.safeParse(card))
	.filter((r) => r.success)
	.filter((r) =>
		taskNamesMatch(
			r.data.properties["Task name"].title.map((t) => t.plain_text).join(""),
			TASK_NAME,
		),
	)
	.map((r) => r.data);

// 4. Report
console.log(
	`\n📋  Found ${matchingCards.length} card(s) matching "${TASK_NAME}":\n`,
);

if (matchingCards.length === 0) {
	console.log("   (none — the card may have been renamed or deleted)");
} else {
	for (const card of matchingCards) {
		const name = card.properties["Task name"].title
			.map((t) => t.plain_text)
			.join("");
		const timeSpent = card.properties["Time Spent"].rich_text
			.map((t) => t.plain_text)
			.join("")
			.trim();
		const url = `https://notion.so/${card.id.replaceAll("-", "")}`;

		console.log(`   ID:         ${card.id}`);
		console.log(`   Name:       "${name}"`);
		console.log(`   Time Spent: "${timeSpent || "(empty)"}"`);
		console.log(`   URL:        ${url}`);
		console.log();
	}

	if (matchingCards.length > 1) {
		console.log(
			`⚠️   DUPLICATE DETECTED — ${matchingCards.length} cards share this name.`,
		);
		console.log(
			"    Delete or rename the extra card(s) in Notion to resolve the error.\n",
		);
	} else {
		console.log("✅  Only one card found — no duplicates at the moment.\n");
	}
}
