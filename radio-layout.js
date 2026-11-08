// Safe, width-constrained SVG typography for the 1280x720 broadcast canvas.
// Text stays inside x=540..1130, safely clear of the 390px cover art.
const escapeXml = value => String(value ?? '').replace(/[<>&"']/g, x => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[x]));

function glyphUnits(s) {
 let units=0;
 for(const ch of Array.from(s)) {
  if(/[ ilI.,!:'|]/.test(ch))units+=0.29;
  else if(/[mwMW@%]/.test(ch))units+=0.9;
  else if(/[A-Z0-9]/.test(ch))units+=0.65;
  else if(/\s/.test(ch))units+=0.3;
  else units+=0.56;
 }
 return units;
}
function widthPx(s,size){return glyphUnits(s)*size;}
function clipToWidth(s,limit,size,ellipsis=false){
 let chars=Array.from(s);
 const suffix=ellipsis?'…':'';
 while(chars.length && widthPx(chars.join('')+suffix,size)>limit)chars.pop();
 return chars.join('').trimEnd()+suffix;
}
export function fitText(text,{width=580,maxLines=2,maxSize=34,minSize=21}={}){
 const words=String(text??'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
 if(!words.length)return {lines:[''],size:maxSize};
 for(let size=maxSize;size>=minSize;size--){
  const lines=[];let current='';
  for(const word of words){
   const test=current?current+' '+word:word;
   if(widthPx(test,size)<=width){current=test;continue;}
   if(current){lines.push(current);current='';}
   if(widthPx(word,size)<=width){current=word;continue;}
   // Long unbroken tokens must be split, not allowed to overflow.
   let rest=word;
   while(rest){
    const piece=clipToWidth(rest,width,size);
    if(!piece)break;
    lines.push(piece);
    rest=rest.slice(piece.length);
   }
  }
  if(current)lines.push(current);
  if(lines.length<=maxLines)return {lines:lines.length?lines:[''],size};
 }
 // At minimum readable font size, use the available lines then ellipsize.
 const size=minSize,lines=[],remaining=[...words];let current='';
 while(remaining.length&&lines.length<maxLines){
  const next=remaining.shift(),candidate=current?current+' '+next:next;
  if(widthPx(candidate,size)<=width){current=candidate;continue;}
  if(current){lines.push(current);current='';remaining.unshift(next);}
  else {current=clipToWidth(next,width,size);if(current!==next)remaining.unshift('…');}
 }
 if(current&&lines.length<maxLines)lines.push(current);
 if(!lines.length)lines.push('');
 if(remaining.length){
  const last=lines.length-1;
  lines[last]=clipToWidth(lines[last],width,size,true);
 }
 return {lines,size};
}
function svgText(value,x,y,{color,size=34,minSize=21,width=580,lines=2,lineHeight=1.3}={}){
 const fitted=fitText(value,{width,maxLines:lines,maxSize:size,minSize});
 const markup=fitted.lines.map((line,index)=>
  '<text x="'+x+'" y="'+(y+index*Math.round(fitted.size*lineHeight))+
  '" font-family="DejaVu Sans,sans-serif" font-size="'+fitted.size+
  '" fill="'+color+'" textLength="'+Math.min(width,Math.ceil(widthPx(line,fitted.size)*1.07))+
  '" lengthAdjust="spacingAndGlyphs">'+escapeXml(line)+'</text>').join('');
 return {markup,height:fitted.size+(fitted.lines.length-1)*Math.round(fitted.size*lineHeight),...fitted};
}
export function svgBackground(station,track){
 const name=svgText(station.name||'Radio',540,180,{color:'#70e7c4',size:35,minSize:23,width:510,lines:1});
 const tagline=svgText(station.tagline||'LIVE RADIO',540,258,{color:'#b8c5da',size:22,minSize:18,width:570,lines:1});
 const title=svgText(track.title||'Live Radio',540,366,{color:'#ffffff',size:34,minSize:22,width:575,lines:2,lineHeight:1.3});
 const artistY=366+title.height+40;
 const artist=svgText(track.artist||station.name||'Radio',540,Math.min(artistY,510),{color:'#b8c5da',size:26,minSize:19,width:575,lines:2});
 return Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs>'+
 '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/>'+
 '<stop offset="1" stop-color="#273469"/></linearGradient></defs>'+
 '<rect width="1280" height="720" fill="url(#bg)"/>'+
 '<rect x="64" y="68" width="1152" height="584" rx="32" fill="#0f172acc"/>'+
 name.markup+tagline.markup+title.markup+artist.markup+
 '<circle cx="1110" cy="170" r="12" fill="#ff5266"/>'+
 '<text x="1136" y="180" font-family="DejaVu Sans,sans-serif" font-size="24" fill="white">LIVE</text></svg>');
}

// Choose a valid new cover when present; transient failures and empty responses
// never clear the previously displayed artwork.
export function retainArtwork(previous,newCover) {
 return Buffer.isBuffer(newCover) && newCover.length ? newCover : (previous || null);
}
