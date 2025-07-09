import { HOUR, MINUTE } from "better-memory-cache";
import { z } from "zod";
import { getHoursByName, isFirstRun } from "./harvest";
import { logMessage, warn } from "./logging";
import { getPage, queryDatabase, sendError, updateHours } from "./notion";
import { clientNamesMatch, taskNamesMatch } from "./util";

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
		"Time Spent": z.object({
			rich_text: z.array(
				z.object({
					plain_text: z.string(),
				}),
			),
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
			.join("")
			.trim();
		this.projectName = client.properties["Project Name"].title
			.map((t) => t.plain_text)
			.join("")
			.trim();
		this.localHours = initialHours ?? 0;
		NotionCard.allCards[card.id] = this;

		logMessage(
			`downloaded card for [${this.projectName}] - "${this.taskName}"`,
		);

		setTimeout(
			() => {
				this.randomUpdate();
			},
			HOUR * Math.random() + 10 * MINUTE,
		);
	}

	private getHours() {
		return this.localHours + this.childHours;
	}

	private async randomUpdate() {
		this.update();
		setTimeout(() => {
			this.randomUpdate();
		}, HOUR);
	}

	public async update() {
		const data = cardSchema.safeParse(await getPage(this.notionId)).data;
		if (!data) return this.localHours;

		const previousHoursAsText = data.properties["Time Spent"].rich_text
			.map((t) => t.plain_text)
			.join("")
			.trim()
			.split(" ")
			.at(0)
			?.trim();
		const previousHours = Number.parseFloat(previousHoursAsText ?? "");

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

		// actually update the page
		const newHours = this.getHours();
		if (newHours === previousHours) {
			logMessage(
				`[SKIP] hours for [${this.projectName}] - "${this.taskName}" did not change (${newHours})`,
			);
			return;
		}
		await updateHours(this.notionId, newHours);
		logMessage(
			`[WRITE] updated hours for [${this.projectName}] - "${this.taskName}" to ${
				Math.round(newHours * 100) / 100
			} (${this.localHours} + ${Math.round(this.childHours * 100) / 100})`,
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

			logMessage("downloading referenced card:", props.id);

			const card = cardSchema.safeParse(await getPage(props.id)).data;
			if (!card) return null;

			const projectId = card.properties.Project.relation.at(0)?.id;
			if (!projectId) return null;

			const client = clientSchema.safeParse(await getPage(projectId)).data;
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

		if (!isFirstRun())
			logMessage(`downloading card for [${props.project}] - "${props.name}"`);

		const clientRequest = await queryDatabase({
			type: "client",
		});

		const clients = clientRequest.results
			.map((client) => clientSchema.safeParse(client))
			.filter((e) => e.success)
			.filter((client) =>
				clientNamesMatch(
					client.data.properties["Project Name"].title
						.map((title) => title.plain_text)
						.join(""),
					props.project,
				),
			)
			?.map((c) => c.data);
		if (clients.length === 0) {
			warn(`no client found for "${props.project}"`, undefined);
			return null;
		}

		const matchingCardsRequest = await queryDatabase({
			type: "task",
			filter: {
				or: clients.map((client) => ({
					property: "Project",
					relation: {
						contains: client.id,
					},
				})),
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

		// if there are too many cards, that indicates an issue in notion
		if (cards.length > 1) {
			warn(
				`multiple cards found for "${props.name}" in ${props.project}`,
				undefined,
			);
			await Promise.all(cards.map((card) => sendError(card.data.id)));
			return null;
		}

		const card = cards[0]?.data;
		if (!card) {
			warn(`no card found for "${props.name}" in ${props.project}`, undefined);
			return null;
		}

		const client = clients.find(
			(c) => c.id === card.properties.Project.relation.at(0)?.id,
		);

		if (!client) {
			warn(
				`we found a card for "${props.name}" in ${props.project}, but then the client came back empty!`,
				undefined,
			);
			return null;
		}

		if (!isFirstRun())
			logMessage(`downloading card for [${props.project}] - "${props.name}"`);

		return new NotionCard({ card, client });
	}
}
