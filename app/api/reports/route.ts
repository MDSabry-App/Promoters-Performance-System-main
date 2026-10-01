import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req:Request){
  const u=new URL(req.url); const year=Number(u.searchParams.get("year")); const month=Number(u.searchParams.get("month"));
  if(!year||month<1||month>12)return NextResponse.json({error:"Invalid year/month"},{status:400});
  const from=new Date(Date.UTC(year,month-1,1)),to=new Date(Date.UTC(year,month,1));
  const [employees,invoices,targets,warranty,agency]=await Promise.all([
    prisma.employee.findMany({where:{status:"ACTIVE"},include:{department:true,company:true,targets:{where:{year,month}}},orderBy:[{department:{code:"asc"}},{name:"asc"}]}),
    prisma.invoice.findMany({where:{date:{gte:from,lt:to}},select:{date:true,amount:true,warranty:true,agency:true,employeeId:true,invoiceNumber:true},orderBy:{date:"asc"}}),
    prisma.monthlyTarget.findMany({where:{year,month},include:{department:true}}),
    prisma.warrantyTarget.findUnique({where:{year_month:{year,month}},include:{employeeTargets:true}}),
    prisma.agencyTarget.findUnique({where:{year_month:{year,month}},include:{employeeTargets:true}})
  ]);
  const warrantyMap=new Map((warranty?.employeeTargets||[]).map(x=>[x.employeeId,Number(x.amount)]));
  const agencyMap=new Map((agency?.employeeTargets||[]).map(x=>[x.employeeId,Number(x.amount)]));
  const byEmployee=employees.map(e=>{
    const own=invoices.filter(i=>i.employeeId===e.id);
    const actual=own.reduce((s,i)=>s+Number(i.amount),0);
    const agencyActual=own.reduce((s,i)=>s+Number(i.agency||0),0);
    const warrantyActual=own.reduce((s,i)=>s+Number(i.warranty||0),0);
    const target=e.targets[0]?Number(e.targets[0].amount):0;
    const agencyTarget=agencyMap.get(e.id)||0;
    const warrantyTarget=warrantyMap.get(e.id)||0;
    return {employeeId:e.id,name:e.name,company:e.company.name,department:e.department.code,target,actual,achievement:target?actual/target*100:0,agencyTarget,agencyActual,agencyAchievement:agencyTarget?agencyActual/agencyTarget*100:0,warrantyTarget,warrantyActual,warrantyAchievement:warrantyTarget?warrantyActual/warrantyTarget*100:0};
  });
  const byDepartment=targets.map(t=>{
    const actual=invoices.filter(i=>employees.some(e=>e.id===i.employeeId&&e.departmentId===t.departmentId)).reduce((s,i)=>s+Number(i.amount),0);
    return {department:t.department.code,target:Number(t.amount),actual,achievement:Number(t.amount)?actual/Number(t.amount)*100:0};
  });
  const days=new Date(Date.UTC(year,month,0)).getUTCDate();
  const daily=Array.from({length:days},(_,idx)=>{const date=idx+1;const rows=employees.map(e=>{const actual=invoices.filter(i=>i.employeeId===e.id&&new Date(i.date).getUTCDate()===date).reduce((s,i)=>s+Number(i.amount),0);return {employeeId:e.id,actual};});return {date,rows};});
  return NextResponse.json({year,month,days,byEmployee,byDepartment,daily,totalActual:invoices.reduce((s,i)=>s+Number(i.amount),0),invoiceCount:invoices.length,specialTargets:{agencyTotal:agency?Number(agency.amount):0,warrantyTotal:warranty?Number(warranty.amount):0}});
}