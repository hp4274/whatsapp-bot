/** Platform rules for campaigns. See `index.js` for the field shape. */

const S = 'campaigns';

export const CAMPAIGN_POLICY = Object.freeze([
    { key: 'campaigns.maxRunning', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 1000, unlimitedAt: 0,
      label: 'Campaigns running at once', hint: '0 = no limit.' },
    { key: 'campaigns.maxScheduled', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 10000, unlimitedAt: 0,
      label: 'Campaigns scheduled ahead', hint: '0 = no limit.' },
    { key: 'campaigns.autoPauseFailurePct', service: S, group: 'Auto-pause', type: 'int', default: 0, min: 0, max: 100, unlimitedAt: 0,
      label: 'Pause above failure rate (%)', hint: 'Checked once 20 messages have gone. 0 = off.' },
    { key: 'campaigns.retentionDays', service: S, group: 'Data', type: 'int', default: 0, min: 0, max: 3650, unlimitedAt: 0,
      label: 'Keep campaign data (days)', hint: 'Finished campaigns and their recipients are deleted after this. 0 = keep forever.' },
    { key: 'campaigns.allowFollowUps', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Follow-ups' },
    { key: 'campaigns.allowScheduling', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Scheduling' },
    { key: 'campaigns.allowInteractive', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Interactive buttons' },
]);
