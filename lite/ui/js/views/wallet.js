// 钱包与刷怪：余额、刷怪收益（../ratting.js，与网站同一个模块）、最近流水
import { esiAuth, esiPaged } from '../esi.js';
import { esc, formatISK, formatPrice, formatNumber, resolveNames, nameOf } from '../data.js';
import * as R from '../ratting.js';

const REF_ZH = {
  bounty_prizes: '赏金', ess_escrow_transfer: 'ESS 托管转账', market_transaction: '市场交易', transaction_tax: '交易税', brokers_fee: '经纪费',
  player_donation: '玩家转账', contract_price: '合同金额', contract_reward: '合同报酬', agent_mission_reward: '任务报酬',
  agent_mission_time_bonus_reward: '任务时间奖励', insurance: '保险', industry_job_tax: '工业税', planetary_export_tax: '行星出口税',
  planetary_import_tax: '行星进口税', market_escrow: '市场托管', daily_goal_payouts: '每日目标奖励', corporation_account_withdrawal: '军团账户取款',
  structure_gate_jump: '建筑跳跃', jump_clone_activation_fee: '跳跃克隆费', skill_purchase: '技能购买', reprocessing_tax: '再处理税'
};
const card = (label, value, detail, kind = '') => {
  const m = /^(.*\S)\s+(ISK)$/.exec(value);
  return `<div class="valuation-card ${kind}"><span class="valuation-label">${label}</span><strong class="valuation-value">${m ? m[1] + '<span class="unit">ISK</span>' : value}</strong><span class="valuation-detail">${detail}</span></div>`;
};

export async function render(box, acc, { isCurrent }) {
  const id = acc.character_id;
  const [balance, journal] = await Promise.all([
    esiAuth(acc, `/characters/${id}/wallet/`),
    esiPaged(acc, `/characters/${id}/wallet/journal/`, 20)
  ]);
  await resolveNames([...journal.flatMap((j) => [j.first_party_id, j.second_party_id]), ...journal.filter((j) => j.context_id_type === 'eve_system').map((j) => j.context_id)]);
  if (!isCurrent()) return;
  const inc = journal.filter((j) => j.amount > 0).reduce((t, j) => t + j.amount, 0);
  const out = -journal.filter((j) => j.amount < 0).reduce((t, j) => t + j.amount, 0);
  const SHOW = 100;
  box.innerHTML = `<div class="valuation-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px">
      ${card('钱包余额', formatPrice(balance) + ' ISK', '')}
      ${card('近期收入', formatISK(inc) + ' ISK', journal.length + ' 条流水（ESI 约 30 天）', 'is-buy')}
      ${card('近期支出', formatISK(out) + ' ISK', '', 'is-sell')}
    </div>
    <div data-ratting></div>
    <div class="card"><h4>最近流水<small>${journal.length > SHOW ? '最近 ' + SHOW + ' 条，共 ' + journal.length + ' 条' : journal.length + ' 条'}</small></h4>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>对方</th><th class="r">金额</th><th class="r">余额</th></tr></thead><tbody>
      ${journal.slice(0, SHOW).map((j) => `<tr><td>${new Date(j.date).toLocaleString('zh-CN', { hour12: false })}</td><td>${esc(REF_ZH[j.ref_type] || j.ref_type)}</td>
        <td>${esc(nameOf(j.first_party_id === id ? j.second_party_id : j.first_party_id) || '')}</td>
        <td class="r ${j.amount >= 0 ? 'up' : 'down'}">${j.amount >= 0 ? '+' : ''}${formatISK(j.amount)}</td><td class="r">${typeof j.balance === 'number' ? formatISK(j.balance) : ''}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  const slot = box.querySelector('[data-ratting]');
  const draw = () => {
    if (!slot.isConnected) return;
    slot.innerHTML = R.rattingHtml(journal, { esc, formatISK, formatNumber, valuationCard: card, systemName: (sid) => nameOf(sid) || 'ID ' + sid });
    R.bindRatting(slot, draw);
  };
  draw();
}
