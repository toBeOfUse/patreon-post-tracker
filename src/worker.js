import { DurableObject } from "cloudflare:workers";

export class PostStorage extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.get('count').then(count => {
      if (!count) {
        ctx.storage.put('count', 1);
      }
    })
  }
  async increment() {
    let current = await this.ctx.storage.get('count');
    await this.ctx.storage.put('count', ++current);
    return current;
  }
}


export default {
  async fetch(request, env, ctx) {
    console.info({ message: 'Hello World Worker received a request!' });

    const object = env.POSTS_DO.getByName('do_name');

    return new Response('Hello World! Counter value is: ' + (await object.increment()));
  }
};