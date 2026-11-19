(()=>{
const chart=document.querySelector('#analyticsChart');
const rangeButtons=[...document.querySelectorAll('[data-range]')];
const summary=document.querySelector('#analyticsSummary');
let selectedRange='week';
function money(value){return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(value/100)}
function drawChart(){
  if(!chart||!ownerAnalytics?.[selectedRange])return;
  const data=ownerAnalytics[selectedRange],dpr=Math.min(window.devicePixelRatio||1,2),width=Math.max(chart.parentElement.clientWidth,320),height=320;
  chart.width=width*dpr;chart.height=height*dpr;chart.style.width=`${width}px`;chart.style.height=`${height}px`;
  const ctx=chart.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
  const pad={top:20,right:22,bottom:46,left:58},plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const maxRevenue=Math.max(...data.map(x=>x.revenue_paise),1),maxOrders=Math.max(...data.map(x=>x.orders),1),step=plotW/data.length,barWidth=Math.max(2,Math.min(30,step*.56));
  ctx.strokeStyle='#d9d7ce';ctx.lineWidth=1;ctx.fillStyle='#6a786f';ctx.font='11px DM Sans';ctx.textAlign='right';
  for(let i=0;i<=4;i++){const y=pad.top+plotH*(i/4);ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();const value=maxRevenue*(1-i/4);ctx.fillText(value>=100000?`₹${Math.round(value/100000)}k`:`₹${Math.round(value/100)}`,pad.left-9,y+4)}
  data.forEach((item,index)=>{const x=pad.left+index*step+step/2,barH=(item.revenue_paise/maxRevenue)*plotH;ctx.fillStyle='#315f4f';ctx.fillRect(x-barWidth/2,pad.top+plotH-barH,barWidth,barH)});
  ctx.strokeStyle='#c28431';ctx.fillStyle='#c28431';ctx.lineWidth=2.5;ctx.beginPath();data.forEach((item,index)=>{const x=pad.left+index*step+step/2,y=pad.top+plotH-(item.orders/maxOrders)*plotH;index?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  data.forEach((item,index)=>{const x=pad.left+index*step+step/2,y=pad.top+plotH-(item.orders/maxOrders)*plotH;ctx.beginPath();ctx.arc(x,y,3.5,0,Math.PI*2);ctx.fill()});
  const labelEvery=selectedRange==='day'?4:selectedRange==='month'?5:1;ctx.fillStyle='#596a60';ctx.font='10px DM Sans';ctx.textAlign='center';data.forEach((item,index)=>{if(index%labelEvery===0||index===data.length-1)ctx.fillText(item.label,pad.left+index*step+step/2,height-18)});
  const totalOrders=data.reduce((sum,item)=>sum+item.orders,0),totalRevenue=data.reduce((sum,item)=>sum+item.revenue_paise,0);const names={day:'last 24 hours',week:'last 7 days',month:'last 30 days',year:'last 12 months'};
  summary.textContent=`${totalOrders} order${totalOrders===1?'':'s'} · ${money(totalRevenue)} revenue in the ${names[selectedRange]}.`;
  chart.setAttribute('aria-label',`${summary.textContent} Revenue bars and order count line chart.`)
}
rangeButtons.forEach(button=>button.addEventListener('click',()=>{selectedRange=button.dataset.range;rangeButtons.forEach(item=>item.classList.toggle('active',item===button));drawChart()}));
if(chart){new ResizeObserver(drawChart).observe(chart.parentElement);drawChart()}

const form=document.querySelector('#ownerProductForm'),files=document.querySelector('#ownerProductImages'),previews=document.querySelector('#ownerImagePreviews'),submit=document.querySelector('#ownerProductSubmit'),message=document.querySelector('#ownerProductMessage');
let previewUrls=[];
function clearPreviews(){previewUrls.forEach(URL.revokeObjectURL);previewUrls=[];previews.replaceChildren()}
if(files)files.addEventListener('change',()=>{clearPreviews();const selected=[...files.files];if(selected.length>4){files.value='';message.textContent='Choose no more than 4 images.';return}message.textContent='';selected.forEach((file,index)=>{const url=URL.createObjectURL(file);previewUrls.push(url);const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=url;img.alt='';caption.textContent=index===0?'Cover image':`Image ${index+1}`;figure.append(img,caption);previews.append(figure)})});
async function readImage(file){if(file.size>5*1024*1024)throw new Error(`${file.name} is larger than 5 MB.`);if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error(`${file.name} is not a supported image.`);const bitmap=await createImageBitmap(file),limit=2000,scale=Math.min(1,limit/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error(`Could not optimise ${file.name}.`)),'image/webp',.84));return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error(`Could not read ${file.name}.`));reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)})}
if(form)form.addEventListener('submit',async event=>{event.preventDefault();const selected=[...files.files];if(!selected.length||selected.length>4){message.textContent='Choose 1–4 product images.';return}submit.disabled=true;submit.textContent='Listing…';message.textContent='Uploading images and creating the product…';try{const fields=Object.fromEntries(new FormData(form));delete fields.image_files;fields.images=await Promise.all(selected.map(readImage));const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(fields)});if(!response.ok)throw new Error(response.status===400?'Check the prices, description and image requirements.':'The product could not be listed. Please try again.');const result=await response.json();location.assign(result.redirect)}catch(error){message.textContent=error.message;submit.disabled=false;submit.textContent='List product'}})
})();
