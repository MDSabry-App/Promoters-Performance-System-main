import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {signSession} from "@/lib/auth";

const DEMO_PASSWORD="Demo@2026";

export async function POST(req:Request){
  const {password}=await req.json().catch(()=>({password:""}));
  const configuredPassword=process.env.ADMIN_PASSWORD;
  const expectedPassword=configuredPassword || DEMO_PASSWORD;
  if(!expectedPassword || password!==expectedPassword){
    return NextResponse.json({error:"Invalid password"},{status:401});
  }
  const c=await cookies();
  c.set("sps_session",signSession(),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:43200,path:"/"});
  return NextResponse.json({ok:true,demo:!configuredPassword});
}