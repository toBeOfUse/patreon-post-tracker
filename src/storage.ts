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
		this.sql(`create table if not exists doa_patreon_posts(
			id text unique,
			title text,
			published_at text,
			comment_count integer,
			like_count integer,
			content_teaser_text text,
			url text
		)`);
		this.sql(`create table if not exists doa_patreon_post_runs(
			started_at text,
			duration_seconds integer,
			posts_retrieved integer
		)`);
	}

	private storeRunStart() {
		const startTime = new Date();
		this.sql(`insert into doa_patreon_post_runs(started_at) values (?)`, startTime.toISOString());
		return startTime;
	}

	private storeRunEnd(startTime: Date, duration: number, retrieved: number) {
		this.sql(
			`update doa_patreon_post_runs set duration_seconds = ?, posts_retrieved = ? where started_at = ?`,
			duration,
			retrieved,
			startTime.toISOString()
		);
	}

	private upsertJsonPosts(posts: PatreonApiResponse) {
		for (const post of posts.data) {
			this.sql(
				`insert or replace into
					doa_patreon_posts(id, title, published_at, comment_count, like_count, content_teaser_text, url)
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
		let apiUrl:
			| string
			| undefined = `https://www.patreon.com/api/posts?fields[campaign]=name%2Curl%2Cpatron_count&fields[post]=change_visibility_at%2Ccomment_count%2Ccommenter_count%2Ccontent%2Ccreated_at%2Ccurrent_user_can_comment%2Ccurrent_user_can_delete%2Ccurrent_user_can_report%2Ccurrent_user_can_view%2Ccurrent_user_comment_disallowed_reason%2Ccurrent_user_has_liked%2Cembed%2Cimage%2Cinsights_last_updated_at%2Cis_paid%2Cis_preview_blurred%2Chas_custom_thumbnail%2Clike_count%2Cpublished_at%2Cpatreon_url%2Cpost_type%2Cpledge_url%2Cpreview_asset_type%2Cthumbnail%2Cthumbnail_url%2Cteaser_text%2Ccontent_teaser_text%2Ctitle%2Cupgrade_url%2Curl%2Cwas_posted_by_campaign_owner%2Chas_ti_violation%2Cmoderation_status%2Cpost_level_suspension_removal_date%2Cpls_one_liners_by_category%2Cvideo%2Cvideo_preview%2Cview_count%2Ccontent_unlock_options%2Cis_new_to_current_user%2Cwatch_state&fields[post_tag]=tag_type%2Cvalue&fields[user]=image_url%2Cfull_name%2Curl&filter[campaign_id]=76490&filter[contains_exclusive_posts]=true&sort=published_at&json-api-use-default-includes=false&json-api-version=1.0`;

		const startTime = this.storeRunStart();

		let retrievedPosts = 0;

		while (true) {
			const response = await fetch(apiUrl);
			const posts = (await response.json()) as PatreonApiResponse;
			this.upsertJsonPosts(posts);
			retrievedPosts += posts.data.length;
			console.log('got', retrievedPosts, 'out of', posts.meta.pagination.total);
			apiUrl = posts.links?.next;
			if (!apiUrl) {
				break;
			}
		}
		console.log('done');
		this.storeRunEnd(startTime, (Date.now() - startTime.getTime()) / 1000, retrievedPosts);
	}

	getPostCount(): number {
		const cursor = this.sql('SELECT COUNT(*) count FROM doa_patreon_posts;');
		const count = cursor.one().count;
		if (typeof count !== 'number') {
			throw new Error('Count is somehow not a number :(');
		}
		return count;
	}

	getLastRun() {
		const sqlQuery = `
		select started_at, duration_seconds, posts_retrieved from doa_patreon_post_runs
			order by started_at desc limit 1`;
		const result = this.sql(sqlQuery);
		return result.one() as
			| {
					started_at: string;
					duration_seconds: number;
					posts_retrieved: number;
			  }
			| undefined;
	}

	getPosts(page = 1, sortBy: SortableColumns = SortableColumns.CommentCount, sortDirection = 'desc', query = '', perPage = 20) {
		if (!Object.values(SortableColumns).includes(sortBy) || !['asc', 'desc'].includes(sortDirection)) {
			console.error('invalid sort parameters:', sortBy, sortDirection);
			return [] as StoredPost[];
		}
		const offset = (page - 1) * perPage;
		const limit = perPage;
		const sqlQuery = `SELECT title, published_at, comment_count, like_count, url 
            FROM doa_patreon_posts
            WHERE title LIKE ("%" || ? || "%")
            order by ${sortBy} ${sortDirection} limit ? offset ?;`;
		const result = this.sql(sqlQuery, query, limit, offset);
		return result.toArray() as StoredPost[];
	}
}
