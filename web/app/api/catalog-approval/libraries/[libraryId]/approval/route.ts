import { issueApproval } from "@/lib/catalog-approval-server";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ libraryId: string }> }): Promise<Response> {
  const { libraryId } = await context.params;
  return issueApproval(request, libraryId);
}
