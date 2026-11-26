import{n as e,t}from"./TableModel-CM3TdVTb.js";import{t as n}from"./popconfirm-4FnFcUJN.js";import{D as r,Gr as i,H as a,Ii as o,O as s,P as c,Ur as l,Wi as u,Xr as d,Zr as f,_i as p,b as m,ei as h,fa as g,ii as _,ji as v,li as y,m as b,mi as x,q as S,s as C,ti as w,ut as T}from"./index-BqETJdWy.js";import E from"./班级管理_form-BphkXFJZ.js";var D={__name:`班级管理连选`,setup(D){x(()=>{A()});let O=o({}),k=o({data:[],rowKey:`id`,rowName:`name`,columns:[{ellipsis:!0,width:160,title:`班级名称`,colKey:`name`},{ellipsis:!0,width:120,title:`班主任`,colKey:`leader`},{ellipsis:!0,width:300,title:`班级口号`,colKey:`slogan`},{ellipsis:!0,width:160,title:`创建时间`,colKey:`createtime`},{ellipsis:!0,width:140,title:`操作`,colKey:`actions`,align:`center`,fixed:`right`}],pagination:{current:1,pageSize:20,total:0},onPageChange(e,t){k.pagination.current=e.current,k.pagination.pageSize=e.pageSize,M()},defaultSelectedRowKeys:[],onSelectChange(e,t){k.defaultSelectedRowKeys=e},activeRowType:`multiple`});function A(){k.pagination.current=1,M()}function j(){Object.keys(O).forEach(e=>delete O[e]),k.pagination.current=1,M()}function M(){b.get(`/api/zone/mzl/class/select`,{...O,current:k.pagination.current,pageSize:k.pagination.pageSize}).then(e=>{k.data=e.data||[],k.pagination.total=e.total||0})}o({});let N={row:{},action:``,dialog:!1,dialog_detail:!1,submitCallback(e){P.action===`insert`?A():M(),Object.assign(P,N)}},P=o({...N});function F(){P.row={},P.action=`insert`,P.dialog=!0}function I(e){P.row=e,P.action=`update`,P.dialog=!0}function L(e){P.row=e,P.action=`detail`,P.dialog=!0}function R(e){b.post(`/api/zone/mzl/class/delete`,{id:e.id}).then(e=>{a.success(e.msg),A()})}function z(){let e=m.confirm({header:`确定删除这${k.defaultSelectedRowKeys.length>1?k.defaultSelectedRowKeys.length:``}条数据？`,body:`请谨慎操作`,confirmBtn:{theme:`danger`},onConfirm:({e:t})=>{e.hide(),R({id:k.defaultSelectedRowKeys.join(`,`)})}})}return(a,o)=>{let m=c,b=s,x=e,D=T,M=r,N=S,B=n;return p(),f(i,null,[w(t,y(u(k),{show_checkbox:!1}),{TableModelHeader:v(()=>[w(M,{ref:`formRef`,data:u(O),layout:`inline`,colon:``,onKeypress:l(A,[`enter`])},{default:v(()=>[w(b,{label:`班级名称`},{default:v(()=>[w(m,{modelValue:u(O).name,"onUpdate:modelValue":o[0]||=e=>u(O).name=e,clearable:``},null,8,[`modelValue`])]),_:1}),w(b,{label:`班主任`},{default:v(()=>[w(m,{modelValue:u(O).leader,"onUpdate:modelValue":o[1]||=e=>u(O).leader=e,clearable:``},null,8,[`modelValue`])]),_:1}),w(b,{label:`建档日期`},{default:v(()=>[w(x,{modelValue:u(O).createtime,"onUpdate:modelValue":o[2]||=e=>u(O).createtime=e,clearable:``},null,8,[`modelValue`])]),_:1}),w(b,null,{default:v(()=>[w(D,{onClick:A},{default:v(()=>[...o[4]||=[h(`查询`,-1)]]),_:1}),w(D,{theme:`default`,variant:`outline`,onClick:j},{default:v(()=>[...o[5]||=[h(`重置`,-1)]]),_:1})]),_:1}),w(b,{toright:``},{default:v(()=>[w(D,{theme:`primary`,onClick:F},{default:v(()=>[...o[6]||=[h(`新增`,-1)]]),_:1}),w(D,{theme:`danger`,onClick:z,disabled:!u(k).defaultSelectedRowKeys.length},{default:v(()=>[...o[7]||=[h(`删除`,-1)]]),_:1},8,[`disabled`])]),_:1})]),_:1},8,[`data`])]),actions:v(({row:e})=>[w(N,{theme:`primary`,onClick:t=>L(e)},{default:v(()=>[...o[8]||=[h(`详情`,-1)]]),_:1},8,[`onClick`]),w(N,{theme:`warning`,onClick:t=>I(e)},{default:v(()=>[...o[9]||=[h(`编辑`,-1)]]),_:1},8,[`onClick`]),w(B,{theme:`danger`,content:`确定删除【${e[u(k).rowName]}】？`,onConfirm:t=>R(e)},{default:v(()=>[w(N,{theme:`danger`},{default:v(()=>[...o[10]||=[h(`删除`,-1)]]),_:1})]),_:1},8,[`content`,`onConfirm`])]),_:1},16),d(` <t-form ref="formRef" :data="form" layout="inline" colon @keypress.enter="click_select">
		<t-form-item label="班级名称">
			<t-input v-model="form.name" clearable />
		</t-form-item>
		<t-form-item label="班主任">
			<t-input v-model="form.leader" clearable />
		</t-form-item>
		<t-form-item label="建档日期">
			<t-date-picker v-model="form.createtime" clearable />
		</t-form-item>
		<t-form-item>
			<t-button @click="click_select">查询</t-button>
			<t-button theme="default" variant="outline" @click="click_reset">重置</t-button>
		</t-form-item>
		<t-form-item toright>
			<t-button theme="primary" @click="click_insert">新增</t-button>
			<t-button theme="danger" @click="click_deletes" :disabled="!table.defaultSelectedRowKeys.length">删除</t-button>
		</t-form-item>
	</t-form>

	<t-table
		:data="table.data"
		:columns="table.columns"
		:pagination="table.pagination"
		:onPageChange="table.onPageChange"
		activeRowType="multiple"
		v-model:activeRowKeys="table.activeRowKeys">
		<template #actions="{ row }">
			<t-link theme="primary" @click="click_detail(row)">详情</t-link>
			<t-link theme="warning" @click="click_update(row)">编辑</t-link>
			<t-popconfirm theme="danger" :content="\`确定删除【\${row[table.rowName]}】？\`" @confirm="click_delete(row)">
				<t-link theme="danger">删除</t-link>
			</t-popconfirm>
		</template></t-table
	> `),w(C,{visible:u(P).dialog,"onUpdate:visible":o[3]||=e=>u(P).dialog=e,width:450,header:{insert:`新增`,update:`${u(P).row[u(k).rowName]} - 编辑`,detail:`${u(P).row[u(k).rowName]} - 详情`}[u(P).action]},{default:v(()=>[w(E,g(_(u(P))),null,16)]),_:1},8,[`visible`,`header`])],64)}}};export{D as default};