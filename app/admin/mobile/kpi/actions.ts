"use server";

import { redirect } from "next/navigation";

export async function downloadKpiCsvAction() {
  redirect("/admin/mobile/kpi/export");
}
