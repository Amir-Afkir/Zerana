/** Content identity is scoped to a world generation and retained resources.
 * A live provider date is NOT an immutable dataset release. Evidence survives
 * with each packet, rather than an unbounded global history of visited tiles. */
export interface SourceRead { readonly layer:'elevation'|'road'; readonly tile:string; readonly sha256:string }
export function canonicalReadSet(reads:readonly SourceRead[]):readonly SourceRead[] {
  if(!Array.isArray(reads)||reads.length>256)throw new Error('ROAD_ENGINEERING_READSET_BUDGET');
  const map=new Map<string,SourceRead>();
  for(const read of reads){
    if(!read||!['elevation','road'].includes(read.layer)||!(/^\d{1,2}\/\d{1,8}\/\d{1,8}$/.test(read.tile))||!(/^[a-f0-9]{64}$/.test(read.sha256)))
      throw new Error('ROAD_ENGINEERING_READSET_CONTRACT');
    const [z,x,y]=read.tile.split('/').map(Number);
    if(z! > 24 || x! >= 2**z! || y! >= 2**z! || `${z}/${x}/${y}`!==read.tile)throw new Error('ROAD_ENGINEERING_READSET_CONTRACT');
    const key=`${read.layer}/${read.tile}`,old=map.get(key);
    if(old&&old.sha256!==read.sha256)throw new Error('ROAD_ENGINEERING_SOURCE_REVISION_CONFLICT');
    map.set(key,Object.freeze({...read}));
  }
  return Object.freeze([...map].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v));
}
/** Compare ALL retained evidence, not just visible neighbours or equal packet
 * sourceIds. An incompatible response cannot replace authoritative ground. */
export function assertReadSetsCompatible(candidate:readonly SourceRead[],existing:readonly (readonly SourceRead[])[]):void {
  const reads=canonicalReadSet(candidate),lookup=new Map(reads.map(r=>[`${r.layer}/${r.tile}`,r.sha256]));
  for(const set of existing)for(const r of canonicalReadSet(set)){
    const expected=lookup.get(`${r.layer}/${r.tile}`);
    if(expected!==undefined&&r.sha256!==expected)throw new Error('ROAD_ENGINEERING_SOURCE_REVISION_CONFLICT');
  }
}
