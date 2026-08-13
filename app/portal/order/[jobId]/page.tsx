"use client";

import { useParams } from "next/navigation";
import OrderForm from "../OrderForm";
import CustomerJobThread from "../../CustomerJobThread";

export default function EditOrderPage() {
  const params = useParams<{ jobId: string }>();
  return (
    <>
      <OrderForm editJobId={params.jobId} />
      <CustomerJobThread jobId={params.jobId} />
    </>
  );
}
