"use client";

import { useParams } from "next/navigation";
import OrderForm from "../OrderForm";

export default function EditOrderPage() {
  const params = useParams<{ jobId: string }>();
  return <OrderForm editJobId={params.jobId} />;
}
