import { DurableObject } from 'cloudflare:workers';

// internal types for dealing with patreon api:

type PatreonPostData = {
	id: string;
	attributes: {
		comment_count: number;
		like_count: number;
		title: string;
		published_at: string;
		content_teaser_text: string;
		url: string;
	};
};

type PatreonApiResponse = {
	data: PatreonPostData[];
	meta: {
		pagination: {
			total: number;
		};
	};
	links: {
		next?: string;
	};
};

// types for interface for storage:

export type StoredPost = {
	title: string;
	published_at: string;
	comment_count: number;
	like_count: number;
	url: string;
};

export type StoredPreviousRun = {
	started_at: string;
	duration_seconds: number;
	posts_retrieved: number;
	last_next_link: string | null;
};

export enum SortableColumns {
	CommentCount = 'comment_count',
	LikeCount = 'like_count',
	PublishedAt = 'published_at',
}

/**
 * Class that is responsible for persisting a copy of a bunch of Patreon posts
 * and letting you query them in ways that Patreon's API doesn't natively
 * support AFAIK. It is possible that this class has too much responsibility;
 * whoops? You could refactor it into a class that provides storage primitives
 * and some other thing that reads from the Patreon API, idk.
 */
export class PostStorage extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.initTables();
	}

	// dumb convenience method
	private sql(query: string, ...bindings: any[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	// storage internals ===================================

	private async initTables() {
		this.sql(`create table if not exists patreon_posts(
			id text unique,
			title text,
			published_at text,
			comment_count integer,
			like_count integer,
			content_teaser_text text,
			url text
		)`);
		this.sql(`create table if not exists patreon_post_runs(
			started_at text,
			duration_seconds integer,
			posts_retrieved integer,
			last_next_link text
		)`);
	}

	private storeRunStart() {
		const startTime = new Date();
		this.sql(`insert into patreon_post_runs(started_at) values (?)`, startTime.toISOString());
		return startTime;
	}

	private storeRunEnd(startTime: Date, duration: number, retrieved: number, last_next_link: string | null) {
		const updateResult = this.sql(
			`update patreon_post_runs set duration_seconds = ?, posts_retrieved = ?, last_next_link = ? where started_at = ?`,
			duration,
			retrieved,
			last_next_link,
			startTime.toISOString()
		);
		if (!updateResult.rowsWritten) {
			console.error('last run not updated');
		}
	}

	private upsertJsonPosts(posts: PatreonApiResponse) {
		for (const post of posts.data) {
			this.sql(
				`insert or replace into
					patreon_posts(id, title, published_at, comment_count, like_count, content_teaser_text, url)
					values (?, ?, ?, ?, ?, ?, ?)`,
				post.id,
				post.attributes.title,
				post.attributes.published_at,
				post.attributes.comment_count,
				post.attributes.like_count,
				post.attributes.content_teaser_text,
				post.attributes.url
			);
		}
	}

	// public interface ===================================

	async syncInPostsFromPatreon() {
		// this function syncs in a selection of posts from the patreon; it
		// can't get all of them since this is running on the cloudflare worker
		// free tier and that only lets you make up to 50 "subrequests" (which
		// is a category of operation that includes fetch() calls) per run. so,
		// this grabs the most recent 20 pages of posts, and then another 20
		// pages from the archives.

		// preemptively grab the data from the most recent sync job in the
		// database before this sync job becomes the most recent sync job in the
		// database
		const lastRun = this.getLastRun();

		// part one: retrieve the most recent 20 pages of posts. the stats on
		// these change frequently, so they're a priority
		let apiUrl:
			| string
			| undefined = `https://www.patreon.com/api/posts?fields[campaign]=name%2Curl%2Cpatron_count&fields[post]=url%2Ccontent_teaser_text%2Ccomment_count%2Ccommenter_count%2Ccontent%2Ccreated_at%2Clike_count%2Cpublished_at%2Cpatreon_url%2Cpost_type%2Ctitle%2Cview_count&fields[post_tag]=tag_type%2Cvalue&filter[campaign_id]=76490&sort=-published_at&json-api-use-default-includes=false&json-api-version=1.0`;

		const startTime = this.storeRunStart();

		let retrievedPosts = 0;

		for (let i = 0; i < 20; ++i) {
			const response = await fetch(apiUrl);
			const posts = (await response.json()) as PatreonApiResponse;
			this.upsertJsonPosts(posts);
			retrievedPosts += posts.data.length;
			console.log(`retrieved ${retrievedPosts} recent posts`);
			apiUrl = posts.links?.next;
			if (!apiUrl) {
				break;
			}
		}

		// part 2: grab posts from the archives, starting immediately after the
		// pages of posts that the previous run grabbed from the archives

		// if there is a "next" link recorded by the previous run, then use it
		// as the starting point for the archive dive, since it should pick up
		// right after the last run's archive dive left off. if there isn't a
		// "next" link from the previous run, then either there is no previous
		// run or the previous run hit the end of the pagination, in which case
		// we can start the archive dive right after the recent posts that we
		// just got, so leaving `apiUrl` at its current value is fine
		if (lastRun?.last_next_link) {
			apiUrl = lastRun.last_next_link;
		}

		// handle the case where there is no "next" link from either the last
		// run or the current run; this would only happen if there were fewer
		// than 20 pages of posts to deal with
		if (!apiUrl) {
			this.storeRunEnd(startTime, (Date.now() - startTime.getTime()) / 1000, retrievedPosts, null);
			return;
		}

		for (let i = 0; i < 20; ++i) {
			const response = await fetch(apiUrl);
			const posts = (await response.json()) as PatreonApiResponse;
			this.upsertJsonPosts(posts);
			retrievedPosts += posts.data.length;
			console.log(`retrieved ${retrievedPosts} total posts`);
			apiUrl = posts.links?.next;
			if (!apiUrl) {
				break;
			}
		}

		// store the `next` link for this run so that the next run can use it as
		// the starting point for its archive dive
		const currentRunsLastNextLink = apiUrl;
		this.storeRunEnd(startTime, (Date.now() - startTime.getTime()) / 1000, retrievedPosts, currentRunsLastNextLink ?? null);
	}

	getPostCount(): number {
		const cursor = this.sql('SELECT COUNT(*) count FROM patreon_posts;');
		const count = cursor.one().count;
		if (typeof count !== 'number') {
			throw new Error('Count is somehow not a number :(');
		}
		return count;
	}

	getLastRun() {
		const lastRunQuery = `
		select started_at, duration_seconds, posts_retrieved, last_next_link from patreon_post_runs
			order by started_at desc limit 1`;
		const lastRun = this.sql(lastRunQuery).next();
		if (lastRun.done) {
			return undefined;
		}
		return lastRun.value as StoredPreviousRun;
	}

	getPosts(page = 1, sortBy: SortableColumns = SortableColumns.CommentCount, sortDirection = 'desc', query = '', perPage = 20) {
		if (!Object.values(SortableColumns).includes(sortBy) || !['asc', 'desc'].includes(sortDirection)) {
			console.error('invalid sort parameters:', sortBy, sortDirection);
			return [] as StoredPost[];
		}
		const offset = (page - 1) * perPage;
		const limit = perPage;
		const sqlQuery = `SELECT title, published_at, comment_count, like_count, url 
            FROM patreon_posts
            WHERE title LIKE ("%" || ? || "%")
            order by ${sortBy} ${sortDirection} limit ? offset ?;`;
		const result = this.sql(sqlQuery, query, limit, offset);
		return result.toArray() as StoredPost[];
	}
}
