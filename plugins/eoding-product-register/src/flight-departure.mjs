const ID=/^[1-9]\d{0,9}$/;
const FLIGHT=/^[A-Z0-9]{2}\d{3,4}$/;
const AIRPORT=/^[A-Z]{3}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const fail=message=>{throw new Error(message);};
function checkedDate(value,label){if(typeof value!=='string'||!DATE.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)fail(`Invalid ${label}`);return value;}
function local(value,label){const match=typeof value==='string'&&/^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)(?::00)?$/.exec(value);if(!match)fail(`Invalid ${label}`);checkedDate(match[1],label);return {date:match[1],time:match[2]};}
function option(value,label){if(!plain(value)||Object.keys(value).length!==2||typeof value.id!=='string'||!value.id||typeof value.label!=='string'||!value.label.trim()||value.label!==value.label.trim())fail(`Invalid ${label}`);return {id:value.id,label:value.label};}
function sourceFlight(value,index){
 const keys=Object.keys(value??{}).sort();const expected=['arrivalLocal','departureLocal','from','number','status','to'];
 if(!plain(value)||!keys.every(k=>expected.includes(k)||k==='departureTimeZone'||k==='arrivalTimeZone')||!expected.every(k=>keys.includes(k))||typeof value.number!=='string'||!FLIGHT.test(value.number)||typeof value.from!=='string'||!AIRPORT.test(value.from)||typeof value.to!=='string'||!AIRPORT.test(value.to)||!['confirmed','planned','unknown'].includes(value.status))fail(`Invalid core source flight ${index}`);
 for(const key of ['departureTimeZone','arrivalTimeZone'])if(key in value&&(typeof value[key]!=='string'||!value[key].trim()||value[key]!==value[key].trim()))fail(`Invalid core source flight ${index}`);
 return {number:value.number,from:value.from,to:value.to,departure:local(value.departureLocal,`source flight ${index} departure`),arrival:local(value.arrivalLocal,`source flight ${index} arrival`),status:value.status,departureTimeZone:value.departureTimeZone,arrivalTimeZone:value.arrivalTimeZone};
}
function checkedInput(input){
 const keys=Object.keys(input??{}).sort().join(',');
 if(!plain(input)||!['bookingStatus,departureSettings,divisionId','bookingStatus,departPort,departureSettings,divisionId'].includes(keys)||typeof input.divisionId!=='string'||(!ID.test(input.divisionId)&&input.divisionId!=='new-product-default')||input.bookingStatus!=='closed'||!Array.isArray(input.departureSettings))fail('Flight departure input must contain a canonical divisionId or new-product-default policy, closed bookingStatus, and departureSettings');
 if('departPort' in input){const value=input.departPort;if(!plain(value)||Object.keys(value).sort().join(',')!=='id,label'||typeof value.id!=='string'||!ID.test(value.id)||typeof value.label!=='string'||!value.label.trim()||value.label!==value.label.trim())fail('Flight departPort must contain canonical id and trimmed label');}
 return input;
}
function settingFor(product,input,index){
 checkedInput(input);if(!plain(product)||product.includesFlight!==true||product.currency!=='KRW'||!Array.isArray(product.departures)||!Number.isSafeInteger(index)||index<0||index>=product.departures.length)fail('Flight-included KRW product and source index are required');
 if(input.departureSettings.length!==product.departures.length||new Set(input.departureSettings.map(v=>v?.index)).size!==input.departureSettings.length)fail('Every flight product departure needs exactly one setting');
 const setting=input.departureSettings.find(v=>plain(v)&&v.index===index);if(!setting)fail('Each flight departure requires exactly one explicit setting');
 if(!['index,maxPax,minPax,segments','fuelSurcharges,index,maxPax,minPax,segments'].includes(Object.keys(setting).sort().join(','))||!Number.isSafeInteger(setting.minPax)||!Number.isSafeInteger(setting.maxPax)||setting.minPax<0||setting.maxPax<1||setting.minPax>setting.maxPax||!plain(setting.segments)||Object.keys(setting.segments).sort().join(',')!=='arrive,depart')fail('Invalid flight departure setting');
 if(setting.fuelSurcharges!==undefined){if(!plain(setting.fuelSurcharges)||Object.keys(setting.fuelSurcharges).sort().join(',')!=='adult,child,infant')fail('Flight fuel surcharge must be explicit zero KRW');for(const kind of ['adult','child','infant'])if(!plain(setting.fuelSurcharges[kind])||setting.fuelSurcharges[kind].currency!=='KRW'||setting.fuelSurcharges[kind].amount!==0)fail('Flight fuel surcharge must be zero KRW');}
 for(const value of input.departureSettings)if(!plain(value)||!Number.isSafeInteger(value.index)||value.index<0||value.index>=product.departures.length)fail('Invalid flight departure setting index');return setting;
}
function resolved(product,input,index){
 const setting=settingFor(product,input,index),departure=product.departures[index];if(!plain(departure)||!Array.isArray(departure.flights)||!departure.flights.length)fail('Normalized flight departure has no flights');
 const source=departure.flights.map(sourceFlight),result={depart:[],arrive:[]},coverage=[];
 for(const direction of ['depart','arrive']){const rawSegments=setting.segments[direction];if(!Array.isArray(rawSegments)||!rawSegments.length||rawSegments.length>3)fail(`Flight departure ${direction} segments are required`);for(const [segmentIndex,raw] of rawSegments.entries()){
  if(!plain(raw)||Object.keys(raw).sort().join(',')!=='airline,arriveAirport,codeShare,dayOffset,departAirport,movingTime,sourceFlightIndex'||!Number.isSafeInteger(raw.sourceFlightIndex)||raw.sourceFlightIndex<0||raw.sourceFlightIndex>=source.length||![-1,0,1,2].includes(raw.dayOffset)||typeof raw.movingTime!=='string'||!/^[1-9]\d{0,3}$/.test(raw.movingTime)||typeof raw.codeShare!=='string'||(raw.codeShare!==''&&!FLIGHT.test(raw.codeShare)))fail(`Invalid ${direction} flight segment`);
  const flight=source[raw.sourceFlightIndex],from=option(raw.departAirport,'departure airport'),to=option(raw.arriveAirport,'arrival airport');if(!from.label.startsWith(`${flight.from} `)||!to.label.startsWith(`${flight.to} `))fail('Flight segment airport does not match exact source flight');
  const sourceDayOffset=(Date.parse(flight.arrival.date+'T00:00:00Z')-Date.parse(flight.departure.date+'T00:00:00Z'))/86400000;
  if(raw.dayOffset!==sourceDayOffset)fail('Flight day offset does not match source local arrival date');
  result[direction].push({departDate:flight.departure.date,flightNo:flight.number,airline:option(raw.airline,'airline'),departAirport:from,arriveAirport:to,departTime:flight.departure.time,arriveTime:flight.arrival.time,dayOffset:raw.dayOffset,movingTime:raw.movingTime,codeShare:raw.codeShare});coverage.push({direction,segmentIndex,sourceFlightIndex:raw.sourceFlightIndex});
 }}
 if(coverage.length!==source.length||new Set(coverage.map(v=>v.sourceFlightIndex)).size!==source.length||coverage.some(v=>v.sourceFlightIndex>=source.length))fail('Flight source coverage must include every core flight exactly once');
 return {segments:result,coverage};
}
/** Parent-flight-form segments bound to the actual ProductSchema flight fields. */
export function flightDepartureSegments(product,input,index){return structuredClone(resolved(product,input,index).segments);}
/** Auditable one-to-one core flight source coverage receipt. */
export function flightDepartureCoverage(product,input,index){return structuredClone(resolved(product,input,index).coverage);}
export function flightDepartureInputIssue(product,input){try{checkedInput(input);if(product?.includesFlight!==true)return 'Flight departure requires includesFlight=true';if(product?.currency!=='KRW')return 'Flight departure requires KRW';if(!Array.isArray(product?.departures)||!product.departures.length)return 'Flight product departures are required';for(let index=0;index<product.departures.length;index+=1){const departure=product.departures[index],price=departure?.prices?.[departure?.selectedPrice??0];checkedDate(departure?.startDate,'flight departure start date');checkedDate(departure?.endDate,'flight departure end date');if(!price?.fuelIncluded)return 'Flight departure requires fuel included';for(const kind of ['adult','child','infant'])if(price?.[kind]?.currency!=='KRW'||!Number.isSafeInteger(price[kind]?.amount)||price[kind].amount<0)return 'Flight departure prices must be non-negative KRW integers';resolved(product,input,index);}return null;}catch(error){return error.message;}}
