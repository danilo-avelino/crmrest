"use client";

import type { IfoodReviewPeriod } from "@dishdesk/shared";
import { IfoodReviews } from "@/components/reports/ifood-reviews";
import { PeriodPicker, useRatings } from "@/components/reports/ratings-shell";
import { SettingsHeader } from "@/components/settings/settings-ui";

const PERIODS: { value: IfoodReviewPeriod; label: string }[] = [
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "90d", label: "90 dias" },
];

export default function IfoodReviewsPage() {
  const { tenantId, ifoodPeriod, setIfoodPeriod } = useRatings();
  return (
    <>
      <SettingsHeader title="iFood" description="As avaliações das lojas no iFood e a resposta do restaurante a cada uma">
        <PeriodPicker options={PERIODS} value={ifoodPeriod} onChange={setIfoodPeriod} />
      </SettingsHeader>
      <IfoodReviews tenantId={tenantId} period={ifoodPeriod} />
    </>
  );
}
