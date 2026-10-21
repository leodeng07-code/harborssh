import type { Profile } from '../../shared/types';
import { GROUP_LEVELS, GROUP_NAME_LIMIT, groupSuggestions } from '../../shared/groups';

export function GroupFields({ levels, onChange, profiles }: { levels: string[]; onChange: (levels: string[]) => void; profiles: Profile[] }) {
  return <fieldset className="group-fields"><legend>主机分组<span>最多三级，可只填写前一至两级</span></legend><div className="group-field-grid">{GROUP_LEVELS.map((name, depth) => <label key={name}>{name}（{['一级', '二级', '三级'][depth]}）<input list={`group-level-${depth}`} maxLength={GROUP_NAME_LIMIT} placeholder={['例如：交换机', '例如：上海', '例如：办公网'][depth]} value={levels[depth] || ''} onChange={event => { const next = Array.from({ length: 3 }, (_, index) => levels[index] || ''); next[depth] = event.target.value; onChange(next); }} /><datalist id={`group-level-${depth}`}>{groupSuggestions(profiles, levels, depth).map(value => <option key={value} value={value} />)}</datalist></label>)}</div></fieldset>;
}
