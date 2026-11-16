/**
 * General section composer — renders the five Settings → General cards
 * in their canonical order under quiet uppercase section headers:
 *
 *   Startup → Notifications → Updates → Privacy → Attribution
 *
 * Each card owns its own persistence; this file is purely visual
 * arrangement. Adding another card is a one-import addition.
 */
import { StartupCard } from "./startup-card";
import { NotificationsCard } from "./notifications-card";
import { UpdatesCard } from "./updates-card";
import { PrivacyCard } from "./privacy-card";
import { AttributionCard } from "./attribution-card";

const sectionHeader: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, letterSpacing: "0.10em",
  color: "var(--c-dim)",
  textTransform: "uppercase",
  marginTop: 4, marginBottom: 10,
  paddingLeft: 1,
};

export function GeneralSection() {
  return (
    <>
      <div style={sectionHeader}>Startup</div>
      <StartupCard />

      <div style={sectionHeader}>Notifications</div>
      <NotificationsCard />

      <div style={sectionHeader}>Updates</div>
      <UpdatesCard />

      <div style={sectionHeader}>Privacy</div>
      <PrivacyCard />

      <div style={sectionHeader}>Attribution</div>
      <AttributionCard />
    </>
  );
}
