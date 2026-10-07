import {validateProduct} from './core.mjs';

/** Validate source facts for the public private-master import boundary.
 * The legacy full/departure validator remains unchanged. Only absent facts for
 * explicitly excluded writes are optional; malformed supplied facts still fail.
 * This is source validation, not approval, duplicate checking, or permission to write.
 */
export function validateProductImport(plan) {
 const result=validateProduct(plan?.product);
 if(!result.valid)return result;
 const mode=plan?.seasonMode;
 if(mode===undefined||mode==='included')return result;
 if(mode!=='excluded')return {...result,readyForReview:false,errors:[...result.errors,{field:'seasonMode',message:'Unknown import season mode'}]};
 const excluded=['season','event','events','eventCreation','hotel','hotels','hotelAssignments'];
 const conflicts=excluded.filter(key=>Object.hasOwn(plan,key)).map(field=>({field,message:'Instruction outside explicit no-season private-master scope'}));
 // These exact field-level errors only express absence. All schema errors,
 // supplied commercial-data errors, operating values, itinerary and unresolved
 // questions remain errors. Never manufacture dates/prices/policy placeholders.
 const optional=new Set();
 if(result.product.departures.length===0){optional.add('departures');optional.add('evidence.departures');}
 if(!result.product.cancellation){optional.add('cancellation');optional.add('evidence.cancellation');}
 const errors=[...result.errors.filter(error=>!optional.has(error.field)),...conflicts];
 return {...result,readyForReview:errors.length===0,errors,
  importScope:{season:'excluded',events:'prohibited',policySettings:'preserved'},
  omittedSourceRequirements:[...optional].filter(field=>!field.startsWith('evidence.'))};
}
