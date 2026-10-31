import { auth } from "../../../../server/auth.ts";

const handler = (request: Request): Promise<Response> => auth().handler(request);
export { handler as GET, handler as POST };
