// /api/mpesa-callback.js
// Idempotent Safaricom callback handler. It only marks a matching order paid after verifying the amount.
module.exports=async(req,res)=>{
  const respondOk=()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});
  try{
    const callback=req.body?.Body?.stkCallback; if(!callback) return respondOk();
    const {CheckoutRequestID,ResultCode,CallbackMetadata}=callback;
    if(!CheckoutRequestID) return respondOk();
    const SUPABASE_URL=process.env.SUPABASE_URL,SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!SUPABASE_URL||!SERVICE_KEY) return respondOk();
    const h={apikey:SERVICE_KEY,Authorization:'Bearer '+SERVICE_KEY};
    const payRes=await fetch(SUPABASE_URL+'/rest/v1/payments?checkout_request_id=eq.'+encodeURIComponent(CheckoutRequestID)+'&select=*',{headers:h});
    if(!payRes.ok) return respondOk();
    const payments=await payRes.json(); if(!payments.length) return respondOk();
    const payment=payments[0]; if(payment.status==='completed'||payment.status==='failed') return respondOk();
    const orderRes=await fetch(SUPABASE_URL+'/rest/v1/orders?id=eq.'+encodeURIComponent(payment.order_id)+'&select=id,total,status',{headers:h});
    const orders=await orderRes.json(); const order=orders[0];
    const patchPayment=async(body)=>fetch(SUPABASE_URL+'/rest/v1/payments?id=eq.'+encodeURIComponent(payment.id),{method:'PATCH',headers:{...h,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(body)});
    if(ResultCode===0 && order){
      const items=CallbackMetadata?.Item||[],receipt=items.find(i=>i.Name==='MpesaReceiptNumber')?.Value||null,paidAmount=Number(items.find(i=>i.Name==='Amount')?.Value||payment.amount_paid);
      if(!Number.isFinite(paidAmount)||paidAmount!==Number(payment.amount_paid)){ await patchPayment({status:'failed',raw_result:callback,updated_at:new Date().toISOString()}); await fetch(SUPABASE_URL+'/rest/v1/rpc/release_order_stock',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({p_order_id:payment.order_id})}); return respondOk(); }
      await patchPayment({status:'completed',mpesa_receipt:receipt,amount_paid:paidAmount,raw_result:callback,updated_at:new Date().toISOString()});
      await fetch(SUPABASE_URL+'/rest/v1/orders?id=eq.'+encodeURIComponent(order.id)+'&status=eq.new',{method:'PATCH',headers:{...h,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({status:'paid'})});
    }else{
      await patchPayment({status:'failed',raw_result:callback,updated_at:new Date().toISOString()});
      await fetch(SUPABASE_URL+'/rest/v1/rpc/release_order_stock',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({p_order_id:payment.order_id})});
    }
    return respondOk();
  }catch(e){ return respondOk(); }
};
