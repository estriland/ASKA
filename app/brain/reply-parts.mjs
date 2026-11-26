// One authoritative segmentation for new bilingual replies; the UI consumes
// these pairs directly. Rich documents stay whole rather than guessing a split.
export function sourceParagraphs(text){
  const value=String(text),normal=value.replace(/\r\n?/g,'\n');
  const rich=/^[ \t]{0,3}(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s)/m.test(normal)
    ||/^[^\n]*\|[^\n]*$/m.test(normal)||/^(?: {4}|\t)\S/m.test(normal)||/\$|\\begin\{|<\/?[A-Za-z][^>]*>/.test(normal);
  if(rich||!(/\n[ \t]*\n/.test(normal)))return [value];
  return normal.split(/\n(?:[ \t]*\n)+/).map(x=>x.trim()).filter(Boolean);
}

export function pairTranslatedParts(value,sourceParts){
  if(!Array.isArray(value.parts)||value.parts.length!==sourceParts.length)return null;
  const parts=[];
  for(const [index,part]of value.parts.entries()){
    if(!part||part.index!==index||typeof part.speech!=='string'||!part.speech.trim())return null;
    if(/^\s*[{[]/.test(part.speech)||/"(?:speech|signals|incidents|node_values)"\s*:/.test(part.speech))return null;
    parts.push({speech:part.speech.trim(),translation:sourceParts[index]});
  }
  return {speech:parts.map(p=>p.speech).join('\n\n'),translation:sourceParts.join('\n\n'),language:'ja',parts};
}
