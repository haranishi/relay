import type { Metadata } from "next";
import { PilotApp } from "../../components/pilot-app";

export const metadata: Metadata = {
  title: "Relay 試験運用",
  robots: { index: false, follow: false }
};

export default function PilotPage() {
  return <PilotApp />;
}
