import { PostStorage } from './storage';

export { PostStorage };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		console.info({ message: 'Hello World Worker received a request!' });

		const object = env.POSTS_DO.getByName('posts_do');

		return new Response(`Hello! Count is ${await object.getPostCount()}.\n\nPosts:\n\n${JSON.stringify(await object.getPosts(), null, 4)}`);
	},
	async scheduled(controller, env, ctx) {
		await env.POSTS_DO.getByName('posts_do').syncInPostsFromPatreon();
	},
} satisfies ExportedHandler<Env>;
