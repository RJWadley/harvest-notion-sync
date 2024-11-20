import { Client } from "@notionhq/client";
import { isFirstRun } from "./harvest";
import { notionRateLimit } from "./limits";

const clientDatabase = Bun.env.CLIENT_DATABASE || "";
const taskDatabase = Bun.env.TASK_DATABASE || "";
const notionToken = Bun.env.NOTION_TOKEN || "";
if (!clientDatabase || !taskDatabase || !notionToken) {
	throw new Error("Missing credentials");
}

const notion = new Client({
	auth: notionToken,
});

export const getPage = async (notionId: string) => {
	await notionRateLimit();
	return notion.pages.retrieve({
		page_id: notionId,
	});
};

export const queryDatabase = async ({
	type,
	filter,
}: {
	type: "client" | "task";
	filter?: { property: string; relation: { contains: string } };
}) => {
	await notionRateLimit();
	return notion.databases.query({
		database_id: type === "client" ? clientDatabase : taskDatabase,
		filter,
	});
};

export const updateHours = async (notionId: string, hours: number) => {
	await notionRateLimit();

	/**
	 * in format 2:21pm, with no leading 0s
	 */
	const currentTime = new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: true,
	});

	try {
		await notion.pages.update({
			page_id: notionId,
			properties: {
				"Time Spent": {
					rich_text: isFirstRun()
						? [
								{
									text: {
										content: `${hours} Hours Spent\t`,
									},
								},
							]
						: [
								{
									text: {
										content: `${hours} Hours Spent\t`,
									},
								},
								// current time, if desired
								{
									type: "equation",
									equation: {
										expression: `^{${currentTime.toLowerCase()}}`,
									},
								},
							],
				},
			},
		});
	} catch (e) {
		console.warn(`failed to update hours for ${notionId}`, e);
	}
};

export const sendError = async (taskId: string) => {
	try {
		await notion.pages.update({
			page_id: taskId,
			properties: {
				"Time Spent": {
					rich_text: [
						{
							text: {
								content: "Time Error: Multiple notion cards found.",
							},
						},
					],
				},
			},
		});
	} catch (e) {
		console.warn(`failed to send error for ${taskId}`, e);
	}
};
