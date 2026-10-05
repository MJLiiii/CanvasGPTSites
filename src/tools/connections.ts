// Port-specific discovery: only validated metadata, with no Canvas request.
import { defineTool } from '../mcp/define-tool';
import { READ_ONLY } from './read-helpers';

export const listCanvasInstances = defineTool({
  name: 'list_canvas_instances', title: 'List Canvas connections', module: 'connections',
  role: 'shared', effect: 'read', canvasScope: 'none',
  description: 'List configured Canvas connection IDs, custom display names and configuration availability. Use the ID as canvas_instance in Canvas tools. Availability does not verify whether a token is accepted by Canvas.',
  params: {}, annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (_args, ctx) => ({ connections: ctx.config.canvasConnections.map((connection) => ({
    id: connection.id, name: connection.name,
    available: connection.errors.length === 0,
  })) }),
});
