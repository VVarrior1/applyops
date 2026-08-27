import { redirect } from "next/navigation";

// Temporary: the public landing page ships in a later build task.
export default function Home() {
  redirect("/login");
}
