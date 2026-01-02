import { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

import { PostStorage, SortableColumns, StoredPost } from './storage';

export { PostStorage };

const durableObjectName = 'doa_posts';

export default {
	// cron job entrypoint; this just asks the durable object to update its
	// storage by retrieving the latest data for all of the posts from the
	// patreon api
	async scheduled(_controller, env, _ctx) {
		// even though it seems like the main worker shouldn't have to await the
		// result of this rpc call, it kinda doesn't want to work unless i do
		await env.POSTS_DO.getByName(durableObjectName).syncInPostsFromPatreon();
	},
	// web request entrypoint; this renders an interface for viewing the stored
	// posts to html and returns it to the client
	async fetch(req, env, _ctx): Promise<Response> {
		const url = new URL(req.url);
		// this app has exactly one page that is lightly customized using query
		// parameters
		if (url.pathname !== '/') {
			return new Response('path not found', { status: 404 });
		}

		// marshall various parameters
		const currentSearchParams = url.searchParams;
		const pageParam = currentSearchParams.get('page');
		const page = pageParam ? Number(pageParam) : 1;
		const sortBy = currentSearchParams.get('sort') ?? 'comment_count';
		const sortDirection = currentSearchParams.get('direction') ?? 'desc';
		const query = currentSearchParams.get('search') ?? '';
		const perPage = 20;

		// use the parameters to get data from the durable object
		const object = env.POSTS_DO.getByName(durableObjectName);
		const { posts, lastRun, totalPosts } = await object.getPageData(page, sortBy as SortableColumns, sortDirection, query, perPage);

		const maxPage = Math.ceil(totalPosts / perPage);
		if (page > maxPage) {
			return new Response(`Page not found; highest available page number is ${maxPage}`, { status: 404 });
		}

		const getPostCellValue = (post: StoredPost, header: keyof StoredPost): ReactNode => {
			const value = post[header];
			if (header === 'published_at') {
				return new Date(value).toLocaleDateString();
			} else if (header === 'title') {
				return (
					<a target="_blank" href={post.url}>
						{value}
					</a>
				);
			}
			return value;
		};

		const formatColumnName = (columnName: keyof StoredPost) => {
			if (columnName === 'comment_count') {
				return 'Comments';
			} else if (columnName === 'like_count') {
				return 'Likes';
			} else if (columnName === 'published_at') {
				return 'Date';
			} else if (columnName === 'title') {
				return 'Post';
			} else {
				return 'URL';
			}
		};

		const columnHeaders = posts.length
			? (Object.keys(posts[0]).filter((col) => col !== 'id' && col !== 'url') as (keyof (typeof posts)[0])[])
			: [];

		const nextPageParams = extendQueryParams(currentSearchParams, {
			page: String(page + 1),
		});
		const prevPageParams = extendQueryParams(currentSearchParams, {
			page: String(page - 1),
		});

		return jsxBodyToWebResponse(
			'DOA Patreon Posts Data Table',
			<>
				<div style={{ padding: 8, paddingBottom: 0 }}>
					<h1>
						<a href="/" style={{ color: 'black', textDecorationColor: 'black' }}>
							Dumbing of Age Patreon Posts
						</a>
					</h1>
					<p>
						This page takes the information you can already get by scrolling through the Patreon feed (whether you're subscribed or not) and
						makes it more sortable and kinda searchable.
					</p>
				</div>
				<table>
					<thead>
						<tr>
							{columnHeaders.map((header) => (
								<th key={header} style={{ whiteSpace: 'nowrap' }}>
									{Object.values(SortableColumns).includes(header as SortableColumns) ? (
										<a
											href={`/?${extendQueryParams(currentSearchParams, {
												sort: header,
												direction: sortDirection === 'asc' || sortBy !== header ? 'desc' : 'asc',
											}).toString()}`}
										>
											{formatColumnName(header)}{' '}
											<span style={{ fontSize: '80%' }}>{sortBy === header ? (sortDirection === 'asc' ? '▲' : '▼') : ''}</span>
										</a>
									) : (
										formatColumnName(header)
									)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{posts.map((post) => (
							<tr key={post.url}>
								{columnHeaders.map((header) => (
									<td key={header}>{getPostCellValue(post, header)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				<form style={{ display: 'flex', gap: '8px', alignItems: 'center', margin: '0px 10px 15px' }}>
					<label style={{ fontSize: 16, margin: 0 }} htmlFor="search">
						Search:
					</label>
					<input defaultValue={query} style={{ fontSize: 16, height: 32, margin: 0, padding: 8 }} id="search" name="search" />
					{!!query && (
						<a href={`/?${extendQueryParams(currentSearchParams, { search: '', page: '1' }).toString()}`}>
							<button style={{ fontSize: 16, margin: 0, padding: '4px 8px', flex: 1 }} type="button">
								Clear
							</button>
						</a>
					)}
					<button style={{ fontSize: 16, margin: 0, padding: '4px 8px', flex: 1 }} type="submit">
						Go
					</button>
				</form>
				<div style={{ display: 'flex', justifyContent: 'space-between' }}>
					<a style={{ visibility: page === 1 ? 'hidden' : undefined }} href={`/?${prevPageParams.toString()}`}>
						Previous
					</a>
					<a style={{ visibility: page === maxPage ? 'hidden' : undefined }} href={`/?${nextPageParams.toString()}`}>
						Next
					</a>
				</div>
				{!!lastRun && (
					<div style={{ margin: '10px', width: '100%', textAlign: 'center' }}>
						<small style={{ color: '#0007', fontSize: '0.7rem' }}>
							Data updater last ran: {new Date(lastRun.started_at).toLocaleString()} UTC
						</small>
					</div>
				)}
			</>
		);
	},
} satisfies ExportedHandler<Env>;

function jsxBodyToWebResponse(title: string, children: React.ReactNode) {
	return new Response(
		`<!DOCTYPE HTML>` +
			renderToString(
				<html lang="en">
					<head>
						<meta charSet="UTF-8" />
						<meta name="viewport" content="width=device-width, initial-scale=1.0" />
						<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
						<title>{title}</title>
					</head>
					<body style={{ maxWidth: '900px', margin: '10px auto', fontSize: 16 }}>{children}</body>
				</html>
			),
		{
			headers: {
				'content-type': 'text/html;',
			},
		}
	);
}

function extendQueryParams(searchParams: URLSearchParams, newParams: Record<string, string>) {
	const copy = new URLSearchParams(searchParams.toString());
	for (const [key, value] of Object.entries(newParams)) {
		copy.set(key, value);
	}
	return copy;
}
