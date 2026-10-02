import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";

const schema=z.object({
  year:z.number().int(),
  month:z.number().int().min(1).max(12),
  type:z.enum(["WARRANTY","AGENCY"]),
  total:z.number().nonnegative(),
  employeeTargets:z.array(z.object({employeeId:z.string(),amount:z.number().nonnegative()})).default([])
});

export async function GET(req:Request){
  const u=new URL(req.url); const year=Number(u.searchParams.get("year")); const month=Number(u.searchParams.get("month"));
  if(!year||month<1||month>12)return NextResponse.json({error:"Invalid year/month"},{status:400});
  const [warranty,agency]=await Promise.all([
    prisma.warrantyTarget.findUnique({where:{year_month:{year,month}},include:{employeeTargets:true}}),
    prisma.agencyTarget.findUnique({where:{year_month:{year,month}},include:{employeeTargets:true}})
  ]);
  return NextResponse.json({warranty,agency});
}
export async function POST(req:Request){
  try{await requireManager(); const d=schema.parse(await req.json());
    const result=await prisma.$transaction(async tx=>{
      if(d.type==="WARRANTY"){
        const target=await tx.warrantyTarget.upsert({
          where:{year_month:{year:d.year,month:d.month}},
          create:{year:d.year,month:d.month,amount:d.total},
          update:{amount:d.total}
        });
        await tx.employeeWarrantyTarget.deleteMany({where:{year:d.year,month:d.month,warrantyTargetId:target.id}});
        if(d.employeeTargets.length)await tx.employeeWarrantyTarget.createMany({data:d.employeeTargets.map(x=>({year:d.year,month:d.month,employeeId:x.employeeId,warrantyTargetId:target.id,amount:x.amount}))});
        await tx.auditLog.create({data:{action:"UPDATE",entity:"WarrantyTarget",entityId:target.id,details:{year:d.year,month:d.month,total:d.total}}});
        return tx.warrantyTarget.findUnique({where:{id:target.id},include:{employeeTargets:true}});
      }
      const target=await tx.agencyTarget.upsert({
        where:{year_month:{year:d.year,month:d.month}},
        create:{year:d.year,month:d.month,amount:d.total},
        update:{amount:d.total}
      });
      await tx.employeeAgencyTarget.deleteMany({where:{year:d.year,month:d.month,agencyTargetId:target.id}});
      if(d.employeeTargets.length)await tx.employeeAgencyTarget.createMany({data:d.employeeTargets.map(x=>({year:d.year,month:d.month,employeeId:x.employeeId,agencyTargetId:target.id,amount:x.amount}))});
      await tx.auditLog.create({data:{action:"UPDATE",entity:"AgencyTarget",entityId:target.id,details:{year:d.year,month:d.month,total:d.total}}});
      return tx.agencyTarget.findUnique({where:{id:target.id},include:{employeeTargets:true}});
    });
    await notifyAll({title:d.type==="WARRANTY"?"تم تحديث هدف BOXI":"تم تحديث هدف الوكالة",body:`الإجمالي ${d.total} لـ ${d.year}-${d.month}`,tag:"target",level:"important"});
    return NextResponse.json(result);
  }catch(e){const m=e instanceof Error?e.message:"";if(m==="MONTH_LOCKED")return NextResponse.json({error:"Month is locked"},{status:423});console.error("SPECIAL_TARGET_SAVE_ERROR",e);return NextResponse.json({error:e instanceof Error?e.message:"Unable to save target"},{status:400});}
}