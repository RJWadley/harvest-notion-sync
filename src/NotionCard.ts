import { Client } from "@notionhq/client";
import { z } from "zod";
import { clientNamesMatch, taskNamesMatch } from "./util";
import { getHoursByName, isFirstRun } from "./harvest";
import { notionRateLimit } from "./limits";

const clientDatabase = Bun.env.CLIENT_DATABASE || "";
const taskDatabase = Bun.env.TASK_DATABASE || "";
if (!clientDatabase || !taskDatabase) {
	throw new Error("Missing credentials");
}

const notion = new Client({
	auth: process.env.NOTION_TOKEN,
});

const cardSchema = z.object({
	id: z.string(),
	properties: z.object({
		"Parent task": z.object({
			relation: z.array(
				z.object({
					id: z.string(),
				}),
			),
		}),
		"Sub-tasks": z.object({
			relation: z.array(
				z.object({
					id: z.string(),
				}),
			),
		}),
		"Task name": z.object({
			title: z.array(z.object({ plain_text: z.string() })),
		}),
		Project: z.object({
			relation: z.array(z.object({ id: z.string() })),
		}),
	}),
});

const clientSchema = z.object({
	id: z.string(),
	properties: z.object({
		"Project Name": z.object({
			title: z.array(z.object({ plain_text: z.string() })),
		}),
	}),
});

export class NotionCard {
	private static allCards: Record<string, NotionCard> = {};

	private notionId: string;

	private taskName: string;
	private projectName: string;

	private localHours: number;
	private childHours = 0;

	private creationTime = Date.now();

	private constructor({
		card,
		client,
		initialHours,
	}: {
		card: z.infer<typeof cardSchema>;
		client: z.infer<typeof clientSchema>;
		initialHours?: number;
	}) {
		this.notionId = card.id;
		this.taskName = card.properties["Task name"].title
			.map((t) => t.plain_text)
			.join("");
		this.projectName = client.properties["Project Name"].title
			.map((t) => t.plain_text)
			.join("");
		this.localHours = initialHours ?? 0;
		NotionCard.allCards[card.id] = this;

		console.log(
			`downloaded card for [${this.projectName}] - "${this.taskName}"`,
		);
	}

	private getHours() {
		return this.localHours + this.childHours;
	}

	public async update() {
		console.log("syncing hours for", this.taskName);

		await notionRateLimit();
		const data = cardSchema.safeParse(
			await notion.pages.retrieve({
				page_id: this.notionId,
			}),
		).data;
		if (!data) return this.localHours;

		this.localHours = await getHoursByName({
			taskName: this.taskName,
			clientName: this.projectName,
		});

		const parentIds = data.properties["Parent task"].relation.map((r) => r.id);
		const childIds = data.properties["Sub-tasks"].relation.map((r) => r.id);

		const children = await Promise.all(
			childIds.map(async (childId) => NotionCard.getOrCreate({ id: childId })),
		);

		this.childHours = children
			.filter((c) => c !== null)
			.reduce((acc, c) => acc + c.getHours(), 0);

		const parents = await Promise.all(
			parentIds.map(async (parentId) =>
				NotionCard.getOrCreate({ id: parentId }),
			),
		);

		await Promise.all(parents.map((p) => p?.update()));

		/**
		 * in format 2:21pm, with no leading 0s
		 */
		const currentTime = new Date().toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "numeric",
			hour12: true,
		});

		// actually update the page
		await notionRateLimit();
		notion.pages.update({
			page_id: this.notionId,
			properties: {
				"Time Spent": {
					rich_text: isFirstRun()
						? [
								{
									text: {
										content: `${this.getHours()} Hours Spent\t`,
									},
								},
							]
						: [
								{
									text: {
										content: `${this.getHours()} Hours Spent\t`,
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
		console.log(
			`[WRITE] updated hours for [${this.projectName}] - "${this.taskName}" to ${this.getHours()} (${this.localHours} + ${this.childHours})`,
		);
	}

	public static async getOrCreate(
		props:
			| { id: string }
			| {
					name: string;
					project: string;
			  },
	) {
		/**
		 * create by id
		 */
		if ("id" in props) {
			const cached = NotionCard.allCards[props.id];
			if (cached) return cached;

			if (!isFirstRun()) console.log("downloading referenced card:", props.id);

			await notionRateLimit();
			const card = cardSchema.safeParse(
				await notion.pages.retrieve({
					page_id: props.id,
				}),
			).data;
			if (!card) return null;

			const projectId = card.properties.Project.relation.at(0)?.id;
			if (!projectId) return null;

			await notionRateLimit();
			const client = clientSchema.safeParse(
				await notion.pages.retrieve({
					page_id: projectId,
				}),
			).data;
			if (!client) return null;

			// when we download a referenced card, we'll need to know the initial hours
			// this is only needed for referenced cards, updates triggered by harvest will automatically update the hours
			const initialHours = await getHoursByName({
				taskName: card.properties["Task name"].title
					.map((t) => t.plain_text)
					.join(""),
				clientName: client.properties["Project Name"].title
					.map((t) => t.plain_text)
					.join(""),
			});

			return new NotionCard({ card, client, initialHours });
		}

		/**
		 * create by name + project
		 */
		const relevantCard = Object.values(NotionCard.allCards).find((card) => {
			return (
				taskNamesMatch(card.taskName, props.name) &&
				clientNamesMatch(card.projectName, props.project)
			);
		});
		if (relevantCard) return relevantCard;

		console.log(`downloading card for [${props.project}] - "${props.name}"`);

		await notionRateLimit();
		const clientRequest = await notion.databases.query({
			database_id: clientDatabase,
		});

		const client = clientRequest.results
			.map((client) => clientSchema.safeParse(client))
			.filter((e) => e.success)
			.find((client) =>
				clientNamesMatch(
					client.data.properties["Project Name"].title
						.map((title) => title.plain_text)
						.join(""),
					props.project,
				),
			)?.data;
		if (!client) {
			console.warn(`no client found for "${props.project}"`);
			return null;
		}

		await notionRateLimit();
		const matchingCardsRequest = await notion.databases.query({
			database_id: taskDatabase,
			filter: {
				property: "Project",
				relation: {
					contains: client.id,
				},
			},
		});

		const cards = matchingCardsRequest.results
			.map((card) => cardSchema.safeParse(card))
			.filter((e) => e.success)
			.filter((card) =>
				taskNamesMatch(
					card.data.properties["Task name"].title
						.map((title) => title.plain_text)
						.join(""),
					props.name,
				),
			);
		const card = cards[0]?.data;
		const secondCard = cards[1]?.data;

		// if there are too many cards, that indicates an issue in notion
		if (secondCard) {
			for (const cardData of cards) {
				const card = cardData.data;

				await notionRateLimit();
				await notion.pages.update({
					page_id: card.id,
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
			}
		}

		if (!card) {
			console.warn(`no card found for "${props.name}"`);
			return null;
		}

		return new NotionCard({ card, client });
	}
}
